// Claude Haiku 4.5 wrapper for Toño's tool-calling loop.
//
// Design notes:
// - Tool use via @anthropic-ai/sdk. Tools are converted from the Gemini-flavored
//   TOOL_DECLARATIONS (UPPERCASE JSON-Schema types) to Anthropic input_schema
//   (lowercase) at the boundary, so the shared schemas file stays untouched.
// - Loop: send messages → receive tool_use block(s) → execute via dispatchTool
//   → feed tool_result block(s) back → repeat until the model returns plain text.
// - Hard cap on tool-call iterations to prevent runaway loops.
// - SDK auto-retry disabled (maxRetries:0) — we implement PRD §18 retry semantics
//   ourselves so we can emit `llm_retry` events and escalate on second failure.
// - System prompt comes from prompts/tono-system.ts.

import Anthropic from "@anthropic-ai/sdk";
import { createLogger } from "@redin/shared";
import {
  TOOL_DECLARATIONS,
  dispatchTool,
  logLlmCall,
  logLlmError,
  type ToolContext,
  type ToolResult,
} from "@redin/tools";
import { TONO_SYSTEM_PROMPT } from "./prompts/tono-system";
import { TONO_PROMPT_SHA } from "./prompt-sha";

// ---------------------------------------------------------------------------
// PRD §18 — ModelUnavailableError signals an Anthropic 5xx after one retry.
// The agent layer catches this and calls escalate_to_hr.
// ---------------------------------------------------------------------------

export class ModelUnavailableError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "ModelUnavailableError";
  }
}

const log = createLogger("tono:llm");

const MODEL = "claude-haiku-4-5";
const TIMEOUT_MS = 30_000;
const MAX_TOOL_ITERATIONS = 6;
const MAX_TOKENS = 1024;
const TEMPERATURE = 0.3;

export interface RunTurnInput {
  // Ordered oldest-first. Each turn is a user/assistant/tool_call/tool_response
  // entry. We translate to Anthropic MessageParam[] at the boundary.
  history: ConversationTurn[];
  userMessage: string;
  toolCtx: ToolContext;
  // Optional router-injected dispatcher. When provided, replaces dispatchTool so
  // the router's pre/post checks apply. agent.ts wires this in.
  dispatcher?: (
    ctx: ToolContext,
    name: string,
    args: Record<string, unknown>
  ) => Promise<ToolResult<unknown>>;
}

export type ConversationTurn =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string }
  | {
      role: "tool_call";
      calls: { name: string; args: Record<string, unknown> }[];
    }
  | {
      role: "tool_response";
      // One entry per preceding call — keep order stable.
      responses: { name: string; response: unknown }[];
    };

export interface RunTurnResult {
  reply: string;
  toolCallsMade: { name: string; args: Record<string, unknown>; result: ToolResult<unknown> }[];
  iterations: number;
}

// Convert Gemini-flavored TOOL_DECLARATIONS (UPPERCASE types) to Anthropic
// input_schema (lowercase). Only the value of `type` keys is lowercased — enum
// values, descriptions, and other strings are preserved as-is.
function lowercaseTypes(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(lowercaseTypes);
  if (node === null || typeof node !== "object") return node;
  const obj = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k === "type" && typeof v === "string") {
      out[k] = v.toLowerCase();
    } else {
      out[k] = lowercaseTypes(v);
    }
  }
  return out;
}

function toolsForAnthropic(): Anthropic.Tool[] {
  return TOOL_DECLARATIONS.map(
    (d) =>
      ({
        name: d.name,
        description: d.description,
        input_schema: lowercaseTypes(d.parameters) as Anthropic.Tool["input_schema"],
      }) satisfies Anthropic.Tool
  );
}

// Convert ConversationTurn[] (our persisted shape) to Anthropic MessageParam[].
// Pair tool_call <-> tool_response by index within consecutive history entries;
// assign synthetic toolu_h<i>_<j> IDs that only need to be consistent within
// this single API call.
function toAnthropicMessages(
  history: ConversationTurn[],
  currentUserMessage: string
): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = [];
  let pendingCallIds: string[] | null = null;
  let turnIdx = 0;
  for (const t of history) {
    if (t.role === "user") {
      out.push({ role: "user", content: t.text });
    } else if (t.role === "assistant") {
      out.push({ role: "assistant", content: t.text });
    } else if (t.role === "tool_call") {
      const ids = t.calls.map((_c, i) => `toolu_h${turnIdx}_${i}`);
      pendingCallIds = ids;
      out.push({
        role: "assistant",
        content: t.calls.map((c, i) => ({
          type: "tool_use" as const,
          id: ids[i] as string,
          name: c.name,
          input: c.args,
        })),
      });
      turnIdx++;
    } else if (t.role === "tool_response") {
      const ids = pendingCallIds ?? t.responses.map((_, i) => `toolu_orphan_${turnIdx}_${i}`);
      out.push({
        role: "user",
        content: t.responses.map((r, i) => ({
          type: "tool_result" as const,
          tool_use_id: ids[i] ?? `toolu_orphan_${turnIdx}_${i}`,
          content:
            typeof r.response === "string"
              ? r.response
              : JSON.stringify(r.response),
        })),
      });
      pendingCallIds = null;
    }
  }
  out.push({ role: "user", content: currentUserMessage });
  return out;
}

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (client) return client;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
  // Disable SDK auto-retry — we implement PRD §18 retry semantics ourselves
  // (one retry on 5xx, then ModelUnavailableError) so we can emit llm_retry
  // events and let the agent layer escalate to HR.
  client = new Anthropic({ apiKey, maxRetries: 0 });
  return client;
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms)
    ),
  ]);
}

// PRD §18: detect retryable Anthropic errors (500, 502, 503, 504, 529 overloaded).
// Timeout errors (our own withTimeout) are NOT retried — they propagate.
function isRetryableAnthropicError(e: unknown): boolean {
  if (e instanceof Error && e.message.includes("timeout after")) return false;
  if (e instanceof Anthropic.InternalServerError) return true;
  if (e instanceof Anthropic.APIError) {
    const s = e.status;
    return s === 502 || s === 503 || s === 504 || s === 529;
  }
  return false;
}

// Fire-and-forget: log an llm_retry event so it's visible in eventos.
async function logLlmRetry(ctx: ToolContext, model: string, attempt: number): Promise<void> {
  try {
    await ctx.supabase.from("eventos").insert({
      type: "llm_retry",
      entity_id: ctx.session_id ?? null,
      actor: "agent" as const,
      meta: { model, attempt },
    });
  } catch {
    // Non-fatal — retry logging must never crash the conversation.
  }
}

// PRD §18: one retry after 500ms on 5xx; throw ModelUnavailableError on second failure.
async function createMessageWithRetry(
  c: Anthropic,
  params: Anthropic.MessageCreateParamsNonStreaming,
  ctx: ToolContext,
  timeoutMs: number
): Promise<Anthropic.Message> {
  try {
    return await withTimeout(c.messages.create(params), timeoutMs, "anthropic messages.create");
  } catch (firstErr) {
    if (!isRetryableAnthropicError(firstErr)) throw firstErr;
    await logLlmRetry(ctx, MODEL, 1);
    await new Promise((res) => setTimeout(res, 500));
    try {
      return await withTimeout(
        c.messages.create(params),
        timeoutMs,
        "anthropic messages.create retry"
      );
    } catch (secondErr) {
      throw new ModelUnavailableError(secondErr);
    }
  }
}

export async function runTurn(input: RunTurnInput): Promise<RunTurnResult> {
  const c = getClient();
  const messages = toAnthropicMessages(input.history, input.userMessage);
  const tools = toolsForAnthropic();

  const toolCallsMade: RunTurnResult["toolCallsMade"] = [];

  for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
    const t0 = Date.now();
    let response: Anthropic.Message;
    try {
      response = await createMessageWithRetry(
        c,
        {
          model: MODEL,
          max_tokens: MAX_TOKENS,
          temperature: TEMPERATURE,
          system: TONO_SYSTEM_PROMPT,
          tools,
          messages,
        },
        input.toolCtx,
        TIMEOUT_MS
      );
    } catch (e) {
      const latency_ms = Date.now() - t0;
      const error_message = e instanceof Error ? e.message : String(e);
      await logLlmError(input.toolCtx, { model: MODEL, error_message, latency_ms });
      throw e;
    }
    const latency_ms = Date.now() - t0;

    const usage = response.usage;
    log.debug("llm usage", {
      in: usage.input_tokens,
      out: usage.output_tokens,
      iter,
    });

    const toolUseBlocks = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
    );
    const textBlocks = response.content.filter(
      (b): b is Anthropic.TextBlock => b.type === "text"
    );

    // Serialize tool calls as name + arg keys only — no values (PII risk).
    const toolCallsMeta = toolUseBlocks.map((b) => ({
      name: b.name,
      args_keys: Object.keys((b.input ?? {}) as Record<string, unknown>),
    }));

    const responseText = textBlocks
      .map((b) => b.text)
      .join("\n")
      .trim();

    // PRD §22 — v1 grounding heuristic. Tighten post-pilot.
    const grounded = toolCallsMeta.length === 0 || responseText.length <= 400;

    await logLlmCall(input.toolCtx, {
      model: MODEL,
      prompt_sha: TONO_PROMPT_SHA,
      prompt_tokens: usage.input_tokens,
      completion_tokens: usage.output_tokens,
      latency_ms,
      tool_calls: toolCallsMeta,
      grounded,
    });

    if (toolUseBlocks.length === 0) {
      // No more tool calls — return model text.
      if (!responseText) log.warn("anthropic returned empty text", { iter });
      return { reply: responseText, toolCallsMade, iterations: iter };
    }

    // Append the assistant turn (full content blocks: text + tool_use).
    messages.push({ role: "assistant", content: response.content });

    // Execute every tool call; build matching tool_result blocks.
    const toolResultBlocks: Anthropic.ToolResultBlockParam[] = [];
    for (const tu of toolUseBlocks) {
      const name = tu.name;
      const args = (tu.input ?? {}) as Record<string, unknown>;
      log.info("tool call", { name, args_keys: Object.keys(args) });
      let result: ToolResult<unknown>;
      try {
        const dispatch = input.dispatcher ?? dispatchTool;
        result = await dispatch(input.toolCtx, name, args);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        log.error("tool threw", { name, error: msg });
        result = { ok: false, error: msg, code: "tool_threw" };
      }
      toolCallsMade.push({ name, args, result });
      // Router signal: max_tools_reached terminates the loop.
      if (!result.ok && result.code === "max_tools_reached") {
        toolResultBlocks.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: JSON.stringify(result),
          is_error: true,
        });
        messages.push({ role: "user", content: toolResultBlocks });
        return { reply: "", toolCallsMade, iterations: iter };
      }
      toolResultBlocks.push({
        type: "tool_result",
        tool_use_id: tu.id,
        content: JSON.stringify(result),
        is_error: !result.ok,
      });
    }
    messages.push({ role: "user", content: toolResultBlocks });
  }

  log.warn("max tool iterations reached", { iterations: MAX_TOOL_ITERATIONS });
  return {
    reply: "Un momento, déjame revisar eso con el equipo y te respondo.",
    toolCallsMade,
    iterations: MAX_TOOL_ITERATIONS,
  };
}
