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
  dispatchTool,
  makeDefaultToolContext,
  type Actor,
  type ToolContext,
  type ToolResult,
} from "@redin/tools";
import { runTurn, type ConversationTurn } from "./gemini";
import { SessionStore } from "./session";
import { wrapData } from "./prompts/data-wrap";
import {
  createTurnSession,
  preDispatch,
  postDispatch,
  applyToolResultToSession,
  type TurnSession,
} from "./router";

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
// User messages are wrapped in <data source="tecnico"> so the model treats them
// as content, never as instructions (PRD §20 injection defense).
// Tool responses are wrapped in <data source="tool"> for the same reason — tool
// outputs may carry user-generated content (e.g. mensajes from postulaciones).
function toTurns(rows: MessageRow[]): ConversationTurn[] {
  const out: ConversationTurn[] = [];
  for (const r of rows) {
    if (r.role === "user" && r.content) {
      out.push({ role: "user", text: wrapData(r.content, "tecnico") });
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
      // Wrap string tool responses in <data source="tool"> so the model
      // treats the payload as content, never as instructions (PRD §20).
      // Non-string responses (objects/arrays) are serialized then wrapped.
      const raw_response = obj.response;
      const response =
        typeof raw_response === "string"
          ? wrapData(raw_response, "tool")
          : typeof raw_response === "object" && raw_response !== null
            ? wrapData(JSON.stringify(raw_response), "tool")
            : raw_response;
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
  // Build a provisional context (no session_id yet) to get the supabase client.
  const baseCtx = input.toolCtx ?? makeDefaultToolContext({ defaultActor: actor });
  const sessions = new SessionStore(baseCtx.supabase);

  const session = await sessions.getOrCreate(phone, input.channel);
  // Rebuild toolCtx with session_id now that we have it.
  const toolCtx: ToolContext = { ...baseCtx, session_id: session.id };
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

  // TurnSession is ephemeral — lives only for this user turn. Tracks tecnico_id
  // (populated by identify_user / register_tecnico) and tool-call count (Rules 1–3).
  const turnSession: TurnSession = createTurnSession();

  // Router-aware dispatcher: applies Rules 1–3 pre-dispatch and Rule 4 post-dispatch.
  // This is the enforcement point — the LLM never bypasses it.
  const routedDispatch = async (
    ctx: ToolContext,
    name: string,
    args: Record<string, unknown>
  ): Promise<ToolResult<unknown>> => {
    const decision = preDispatch(turnSession, name, args);

    if (decision.kind === "refusal" || decision.kind === "terminal") {
      log.warn("router blocked tool call", {
        name,
        code: decision.result.ok ? "" : decision.result.code,
        kind: decision.kind,
      });
      return decision.result;
    }

    // decision.kind === "allow" — use mutated args (Rule 2 applied)
    let result: ToolResult<unknown>;
    try {
      result = await dispatchTool(ctx, name, decision.args);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      result = { ok: false, error: msg, code: "tool_threw" };
    }

    // Update session from identify_user / register_tecnico outcomes.
    applyToolResultToSession(turnSession, name, result);

    // Rule 4: truncate large result sets.
    return postDispatch(result);
  };

  // Wrap the inbound message in <data source="tecnico"> before handing to the
  // LLM. The system prompt instructs Gemini to treat <data> content as data,
  // never instructions — this is the enforcement point for the current turn.
  const turn = await runTurn({
    history,
    userMessage: wrapData(text, "tecnico"),
    toolCtx,
    dispatcher: routedDispatch,
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
