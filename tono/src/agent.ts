// The Toño agent — channel-agnostic. It takes an incoming message from some
// channel (WhatsApp or dashboard chat), loads session history, calls Gemini,
// executes tool calls, persists everything, and returns the reply.
//
// Channel wrappers (Baileys in this repo, Next.js route handler in dashboard)
// adapt the transport but call the same function.

import {
  createLogger,
  normalizePhone,
  type Json,
  type MessageRow,
} from "@redin/shared";
import type { SessionChannel } from "@redin/shared";
import {
  makeDefaultToolContext,
  type Actor,
  type ToolContext,
} from "@redin/tools";
import { runTurn, type ConversationTurn } from "./gemini";
import { SessionStore } from "./session";

const log = createLogger("tono:agent");

export interface HandleMessageInput {
  phone: string;
  text: string;
  channel: SessionChannel;
  // Optional overrides for tests / dashboard API route.
  toolCtx?: ToolContext;
}

export interface HandleMessageResult {
  reply: string;
  session_id: string;
  tool_calls: { name: string; args: Record<string, unknown>; result_ok: boolean }[];
}

// Convert persisted MessageRow[] to the LLM-facing ConversationTurn[] shape.
function toTurns(rows: MessageRow[]): ConversationTurn[] {
  const out: ConversationTurn[] = [];
  for (const r of rows) {
    if (r.role === "user" && r.content) {
      out.push({ role: "user", text: r.content });
    } else if (r.role === "assistant") {
      // We stored tool_calls jsonb alongside assistant messages when the assistant
      // emitted tool calls. Represent them as a tool_call turn.
      if (r.tool_calls) {
        const calls = normalizeToolCalls(r.tool_calls);
        if (calls.length > 0) out.push({ role: "tool_call", calls });
      }
      if (r.content) out.push({ role: "assistant", text: r.content });
    } else if (r.role === "tool" && r.tool_calls) {
      const responses = normalizeToolResponses(r.tool_calls);
      if (responses.length > 0) out.push({ role: "tool_response", responses });
    }
  }
  return out;
}

function normalizeToolCalls(
  raw: Json
): { name: string; args: Record<string, unknown> }[] {
  if (!Array.isArray(raw)) return [];
  const out: { name: string; args: Record<string, unknown> }[] = [];
  for (const item of raw) {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      const obj = item as Record<string, unknown>;
      const name = typeof obj.name === "string" ? obj.name : "";
      const args =
        obj.args && typeof obj.args === "object" && !Array.isArray(obj.args)
          ? (obj.args as Record<string, unknown>)
          : {};
      if (name) out.push({ name, args });
    }
  }
  return out;
}

function normalizeToolResponses(
  raw: Json
): { name: string; response: unknown }[] {
  if (!Array.isArray(raw)) return [];
  const out: { name: string; response: unknown }[] = [];
  for (const item of raw) {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      const obj = item as Record<string, unknown>;
      const name = typeof obj.name === "string" ? obj.name : "";
      const response = obj.response;
      if (name) out.push({ name, response });
    }
  }
  return out;
}

export async function handleMessage(
  input: HandleMessageInput
): Promise<HandleMessageResult> {
  const phone = normalizePhone(input.phone);
  if (!phone) throw new Error("phone required");
  const text = (input.text ?? "").trim();
  if (!text) throw new Error("text required");

  const actor: Actor = `tecnico:${phone}`;
  const toolCtx = input.toolCtx ?? makeDefaultToolContext({ defaultActor: actor });
  const sessions = new SessionStore(toolCtx.supabase);

  const session = await sessions.getOrCreate(phone, input.channel);
  log.info("incoming", {
    phone,
    channel: input.channel,
    session_id: session.id,
    text_len: text.length,
  });

  // Persist inbound BEFORE calling the model — if we crash, we still have the user's words.
  await sessions.recordMessage({
    sessionId: session.id,
    role: "user",
    content: text,
  });

  // Load recent history (includes the message we just inserted; we'll skip the tail
  // since runTurn takes userMessage separately).
  const recent = await sessions.recentMessages(session.id);
  const allButCurrent = recent.slice(0, -1);
  const history = toTurns(allButCurrent);

  const turn = await runTurn({
    history,
    userMessage: text,
    toolCtx,
  });

  // Persist any tool calls (as an assistant row) and responses (as a tool row).
  if (turn.toolCallsMade.length > 0) {
    const callsJson: Json = turn.toolCallsMade.map((t) => ({
      name: t.name,
      args: t.args as Json,
    })) as Json;
    await sessions.recordMessage({
      sessionId: session.id,
      role: "assistant",
      content: null,
      toolCalls: callsJson,
    });
    const responsesJson: Json = turn.toolCallsMade.map((t) => ({
      name: t.name,
      response: (t.result as unknown) as Json,
    })) as Json;
    await sessions.recordMessage({
      sessionId: session.id,
      role: "tool",
      content: null,
      toolCalls: responsesJson,
    });
  }

  // Persist the final assistant reply if any.
  if (turn.reply) {
    await sessions.recordMessage({
      sessionId: session.id,
      role: "assistant",
      content: turn.reply,
    });
  }
  await sessions.touch(session.id);

  return {
    reply: turn.reply,
    session_id: session.id,
    tool_calls: turn.toolCallsMade.map((t) => ({
      name: t.name,
      args: t.args,
      result_ok: t.result.ok,
    })),
  };
}
