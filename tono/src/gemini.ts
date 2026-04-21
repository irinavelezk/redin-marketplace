// Gemini 2.5 Flash wrapper for Toño's tool-calling loop.
//
// Design notes:
// - Function calling via @google/genai. We declare the 9 tools from @redin/tools/schemas.
// - Loop: send messages → receive function_call(s) → execute via dispatchTool → feed
//   function_response back → repeat until the model produces plain text.
// - Hard cap on tool-call iterations to prevent runaway loops.
// - Thinking budget disabled (v1 architect bot pattern — same reasons: structured
//   output, predictable latency/cost).
// - System prompt comes from prompts/tono-system.ts.

import { GoogleGenAI, Type, type Content, type FunctionCall } from "@google/genai";
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

const log = createLogger("tono:gemini");

const MODEL = "gemini-2.5-flash";
const TIMEOUT_MS = 30_000;
const MAX_TOOL_ITERATIONS = 6;

export interface RunTurnInput {
  // Ordered oldest-first. Each turn is a user or model message. We translate to
  // Gemini `Content[]` at the boundary.
  history: ConversationTurn[];
  userMessage: string;
  toolCtx: ToolContext;
  // Optional router-injected dispatcher. When provided, replaces dispatchTool so
  // the router's pre/post checks apply. S04 wires this from agent.ts.
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

// Map our conversation turns to Gemini `Content`. Gemini accepts `user` and
// `model` as roles. Tool calls go in `model` parts as `functionCall`; tool
// responses go in `user` parts as `functionResponse`.
function toGeminiContents(history: ConversationTurn[], currentUserMessage: string): Content[] {
  const out: Content[] = [];
  for (const t of history) {
    if (t.role === "user") {
      out.push({ role: "user", parts: [{ text: t.text }] });
    } else if (t.role === "assistant") {
      out.push({ role: "model", parts: [{ text: t.text }] });
    } else if (t.role === "tool_call") {
      out.push({
        role: "model",
        parts: t.calls.map((c) => ({
          functionCall: { name: c.name, args: c.args },
        })),
      });
    } else if (t.role === "tool_response") {
      out.push({
        role: "user",
        parts: t.responses.map((r) => ({
          functionResponse: { name: r.name, response: { result: r.response } as Record<string, unknown> },
        })),
      });
    }
  }
  out.push({ role: "user", parts: [{ text: currentUserMessage }] });
  return out;
}

// Convert our TOOL_DECLARATIONS (plain JSON schema-ish) to Gemini's Tool shape.
// Gemini uses a Type enum, but passing the string uppercase names works at runtime.
// The shared schemas file is framework-agnostic (JSON-schema-ish), so we cast to
// Gemini's Tool[] at this boundary. `@google/genai` exports `Type`/`Schema` types
// that are stricter than what we author; casting through unknown is intentional.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toolsForGemini(): any[] {
  return [
    {
      functionDeclarations: TOOL_DECLARATIONS.map((d) => ({
        name: d.name,
        description: d.description,
        parameters: d.parameters,
      })),
    },
  ];
}
// Keep Type import alive for future strict binding.
void Type;

let client: GoogleGenAI | null = null;
function getClient(): GoogleGenAI {
  if (client) return client;
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not set");
  client = new GoogleGenAI({ apiKey });
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

export async function runTurn(input: RunTurnInput): Promise<RunTurnResult> {
  const ai = getClient();
  let contents = toGeminiContents(input.history, input.userMessage);

  const toolCallsMade: RunTurnResult["toolCallsMade"] = [];

  for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
    const t0 = Date.now();
    let response: Awaited<ReturnType<typeof ai.models.generateContent>>;
    try {
      response = await withTimeout(
        ai.models.generateContent({
          model: MODEL,
          contents,
          config: {
            systemInstruction: TONO_SYSTEM_PROMPT,
            tools: toolsForGemini(),
            temperature: 0.3,
            maxOutputTokens: 1024,
            thinkingConfig: { thinkingBudget: 0 },
          },
        }),
        TIMEOUT_MS,
        "gemini generateContent"
      );
    } catch (e) {
      const latency_ms = Date.now() - t0;
      const error_message = e instanceof Error ? e.message : String(e);
      await logLlmError(input.toolCtx, { model: MODEL, error_message, latency_ms });
      throw e;
    }
    const latency_ms = Date.now() - t0;

    const usage = response.usageMetadata;
    if (usage) {
      log.debug("gemini usage", {
        in: usage.promptTokenCount,
        out: usage.candidatesTokenCount,
        iter,
      });
    }

    // Look at the first candidate; grab any functionCalls.
    const candidate = response.candidates?.[0];
    const parts = candidate?.content?.parts ?? [];
    const functionCalls: FunctionCall[] = parts
      .map((p) => p.functionCall)
      .filter((fc): fc is FunctionCall => !!fc);

    // Serialize tool calls as name + arg keys only — no values (PII risk).
    const toolCallsMeta = functionCalls.map((fc) => ({
      name: fc.name ?? "",
      args_keys: Object.keys((fc.args ?? {}) as Record<string, unknown>),
    }));

    const responseText = response.text ?? "";

    // PRD §22 — v1 heuristic. Tighten post-pilot with token-overlap check.
    const grounded =
      toolCallsMeta.length === 0 || responseText.length <= 400;

    await logLlmCall(input.toolCtx, {
      model: MODEL,
      prompt_sha: TONO_PROMPT_SHA,
      prompt_tokens: usage?.promptTokenCount ?? undefined,
      completion_tokens: usage?.candidatesTokenCount ?? undefined,
      latency_ms,
      tool_calls: toolCallsMeta,
      grounded,
    });

    if (functionCalls.length === 0) {
      // No more tool calls — return model text.
      if (!responseText.trim()) {
        log.warn("gemini returned empty text", { iter });
      }
      return { reply: responseText.trim(), toolCallsMade, iterations: iter };
    }

    // Execute every function call. Append the model's call + the responses to contents.
    const callParts = functionCalls.map((fc) => ({
      functionCall: { name: fc.name ?? "", args: (fc.args ?? {}) as Record<string, unknown> },
    }));
    contents.push({ role: "model", parts: callParts });

    const responseParts: { functionResponse: { name: string; response: Record<string, unknown> } }[] = [];
    for (const fc of functionCalls) {
      const name = fc.name ?? "";
      const args = (fc.args ?? {}) as Record<string, unknown>;
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
      // S04 Rule 3: router signals loop termination via max_tools_reached.
      if (!result.ok && result.code === "max_tools_reached") {
        contents.push({ role: "user", parts: responseParts });
        return { reply: "", toolCallsMade, iterations: iter };
      }
      responseParts.push({
        functionResponse: {
          name,
          // Gemini wraps the tool result under `response`; we stash the full
          // ToolResult under `.result` so the model sees both ok/error.
          response: { result: result as unknown as Record<string, unknown> },
        },
      });
    }
    contents.push({ role: "user", parts: responseParts });
  }

  log.warn("max tool iterations reached", { iterations: MAX_TOOL_ITERATIONS });
  return {
    reply: "Un momento, déjame revisar eso con el equipo y te respondo.",
    toolCallsMade,
    iterations: MAX_TOOL_ITERATIONS,
  };
}
