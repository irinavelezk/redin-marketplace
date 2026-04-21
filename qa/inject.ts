/**
 * qa/inject.ts — EVAL-ONLY message injector.
 *
 * Drives Toño for a single utterance without Baileys. Calls handleMessageForEval
 * (alias for handleMessage) and returns reply + full tool trace + eventos written.
 *
 * No mocks — uses real Supabase (test-prefixed rows) and real Gemini.
 */

import { createLogger, createServerClient } from "@redin/shared";
import {
  makeDefaultToolContext,
  LoggingEscalationSink,
  type ToolResult,
} from "@redin/tools";
import { handleMessageForEval } from "../tono/src/agent.js";

const log = createLogger("qa:inject");

export interface TurnToolCall {
  name: string;
  args: Record<string, unknown>;
  result: ToolResult<unknown>;
}

export interface EventoRecord {
  type: string;
  meta: Record<string, unknown>;
}

export interface InjectResult {
  reply: string;
  toolCallsMade: TurnToolCall[];
  eventosWritten: EventoRecord[];
}

/**
 * Inject one user utterance into Toño for the given phone.
 * turnStart is used to filter eventos created during this turn.
 */
export async function injectMessage(
  phone: string,
  text: string,
  turnStart: Date,
  sessionId?: string
): Promise<InjectResult> {
  const supabase = createServerClient();
  const sink = new LoggingEscalationSink(log);
  const toolCtx = makeDefaultToolContext({
    supabase,
    defaultActor: `tecnico:${phone}` as const,
    escalationSink: sink,
    session_id: sessionId,
  });

  const result = await handleMessageForEval({
    phone,
    text,
    channel: "whatsapp",
    toolCtx,
  });

  // Fetch eventos written by the agent AFTER turnStart.
  // actor = "agent" covers llm_call, refused, escalation, tecnico_registered, etc.
  const { data: eventRows } = await supabase
    .from("eventos")
    .select("type, meta")
    .eq("actor", "agent")
    .gte("created_at", turnStart.toISOString())
    .order("created_at", { ascending: true });

  const eventosWritten: EventoRecord[] = (eventRows ?? []).map((e) => ({
    type: e.type,
    meta: (e.meta ?? {}) as Record<string, unknown>,
  }));

  return {
    reply: result.reply,
    toolCallsMade: result.tool_calls_full,
    eventosWritten,
  };
}
