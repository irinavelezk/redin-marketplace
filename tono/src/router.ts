// Tool router — policy enforcement layer (PRD §19).
//
// This module is the single enforcement point for ALL tool-call rules that cannot
// be trusted to the LLM. Pure functions operating over (TurnSession, toolName,
// toolArgs, toolResult). No I/O, no side effects.
//
// Rule catalogue:
//   Rule 1 — Identify-first + auth gating
//   Rule 2 — Session-bound tecnico_id override (anti-auth-bypass)
//   Rule 3 — Max 3 tool calls per user turn
//   Rule 4 — ≥50-row truncation, ranked, with "y hay más" marker

import type { ToolResult } from "@redin/tools";

// ---------- Session state ----------

// TurnSession is created fresh per handleMessage call and lives only for the
// duration of one user turn. It is NOT persisted — DB session is separate.
export interface TurnSession {
  /** Set after identify_user returns found=true, or after register_tecnico succeeds. */
  tecnico_id: string | null;
  /** Increments each time the router dispatches a tool. Blocked at 3. */
  toolCallCount: number;
}

export function createTurnSession(): TurnSession {
  return { tecnico_id: null, toolCallCount: 0 };
}

// ---------- Auth-gated tool set ----------

// These tools require an identified técnico. Everything else is auth-free.
// Single source of truth — not scattered across tool files.
//
// Stream A additions (2026-05-07):
// - submit_candidate_dossier — needs tecnico_id; takes tecnico_id arg
// - mark_candidate_withdrawn — needs tecnico_id; takes tecnico_id arg
// - complete_legacy_profile  — needs tecnico_id; takes tecnico_id arg
// - find_by_cedula           — pure read; auth-free; no tecnico_id arg
// - find_legacy_by_name      — pure read; auth-free; no tecnico_id arg
const AUTH_GATED_TOOLS = new Set([
  "create_postulacion",
  "upload_documento",
  "read_my_postulaciones",
  "read_my_contratos",
  "submit_candidate_dossier",
  "mark_candidate_withdrawn",
  "complete_legacy_profile",
]);

// Tools whose args may carry a tecnico_id that the LLM supplied and that MUST
// be overridden by session.tecnico_id before dispatch (PRD §19 rule 3 / §20).
const TOOLS_WITH_TECNICO_ID_ARG = new Set([
  "create_postulacion",
  "upload_documento",
  "read_my_postulaciones",
  "read_my_contratos",
  "read_pending_ots", // optional arg, but must still be session-bound when present
  "submit_candidate_dossier",
  "mark_candidate_withdrawn",
  "complete_legacy_profile",
]);

// ---------- Rule 1: identify-first + auth gating ----------

export interface RouterRefusal {
  kind: "refusal";
  result: ToolResult<never>;
}

export interface RouterTerminal {
  kind: "terminal"; // agent loop should stop after this
  result: ToolResult<never>;
}

export interface RouterAllow {
  kind: "allow";
  /** Possibly-mutated args (Rule 2 applied). */
  args: Record<string, unknown>;
}

export type PreDispatchDecision = RouterRefusal | RouterTerminal | RouterAllow;

/**
 * Check whether a tool call should be dispatched, applying rules 1–3 in order.
 * Mutates `session.toolCallCount` on allow.
 */
export function preDispatch(
  session: TurnSession,
  toolName: string,
  rawArgs: Record<string, unknown>
): PreDispatchDecision {
  // Rule 3 — max 3 tool calls per user turn. Check FIRST so the counter stays
  // accurate even if rule 1 or 2 fires later.
  if (session.toolCallCount >= 3) {
    return {
      kind: "terminal",
      result: {
        ok: false,
        error:
          "Ya miré varias cosas — déjame responder con lo que tengo.",
        code: "max_tools_reached",
      },
    };
  }

  // Rule 1 — auth-gated tools require an identified técnico.
  if (AUTH_GATED_TOOLS.has(toolName) && session.tecnico_id === null) {
    return {
      kind: "refusal",
      result: {
        ok: false,
        error:
          "Antes de esto necesito saber quién eres — dame tu cédula o el número de teléfono que usas aquí.",
        code: "not_identified",
      },
    };
  }

  // Rule 2 — session-bound tecnico_id override.
  // PRD §19 — session-bound, LLM args discarded.
  let args = rawArgs;
  if (
    TOOLS_WITH_TECNICO_ID_ARG.has(toolName) &&
    session.tecnico_id !== null &&
    "tecnico_id" in rawArgs
  ) {
    args = { ...rawArgs, tecnico_id: session.tecnico_id };
  }

  // All checks passed — increment counter and allow.
  session.toolCallCount += 1;
  return { kind: "allow", args };
}

// ---------- Rule 4: ≥50-row truncation ----------

// Ranking fields per PRD §9.4 / §19 rule 5: disponibilidad → calidad → costo.
// These fields may or may not be present on any given row; we rank defensively.
// If they're absent, the tool already returned rows in a sensible order, so we
// delegate ranking to the tool and just cap at 20. (Ranking comment: "delegated to
// tool" — the HR dashboard UI handles visible ranking per PRD §11.)
function rankRows(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  // Sort descending: higher disponibilidad first, then calidad, then lower costo.
  return [...rows].sort((a, b) => {
    const disp =
      numericField(b, "disponibilidad") - numericField(a, "disponibilidad");
    if (disp !== 0) return disp;
    const cal = numericField(b, "calidad") - numericField(a, "calidad");
    if (cal !== 0) return cal;
    // costo: lower is better, so sort ascending (a - b in original = b[costo] - a[costo] descending)
    return numericField(a, "costo") - numericField(b, "costo");
  });
}

function numericField(row: Record<string, unknown>, field: string): number {
  const v = row[field];
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = parseFloat(v);
    return isNaN(n) ? 0 : n;
  }
  return 0;
}

const TRUNCATION_THRESHOLD = 50;
const TRUNCATION_LIMIT = 20;

/**
 * If the tool result contains an array of ≥50 rows, truncate to top 20 ranked by
 * disponibilidad → calidad → costo. Appends `truncated: true, total: N` to the
 * result data so the agent can emit "y hay más" to the LLM context.
 *
 * Works on any `ToolResult<T>` where T has a top-level array property.
 * If the result is an error, passes through unchanged.
 */
export function postDispatch(result: ToolResult<unknown>): ToolResult<unknown> {
  if (!result.ok) return result;

  const data = result.data;
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    // Flat array at top level — rare, but handle it.
    if (Array.isArray(data) && data.length >= TRUNCATION_THRESHOLD) {
      const typed = data as Record<string, unknown>[];
      const ranked = rankRows(typed).slice(0, TRUNCATION_LIMIT);
      return {
        ok: true,
        data: {
          rows: ranked,
          truncated: true,
          total: data.length,
          note: "y hay más",
        },
      };
    }
    return result;
  }

  // Look for the first array-valued property in the result object.
  const obj = data as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    const val = obj[key];
    if (Array.isArray(val) && val.length >= TRUNCATION_THRESHOLD) {
      const typed = val as Record<string, unknown>[];
      const ranked = rankRows(typed).slice(0, TRUNCATION_LIMIT);
      return {
        ok: true,
        data: {
          ...obj,
          [key]: ranked,
          truncated: true,
          total: val.length,
          note: "y hay más",
        },
      };
    }
  }

  return result;
}

// ---------- Session update from tool results ----------

/**
 * After identify_user or register_tecnico succeeds, extract the tecnico_id and
 * store it on the TurnSession so subsequent auth-gated tools are unlocked.
 */
export function applyToolResultToSession(
  session: TurnSession,
  toolName: string,
  result: ToolResult<unknown>
): void {
  if (!result.ok) return;

  if (toolName === "identify_user") {
    const data = result.data as Record<string, unknown> | null;
    if (
      data !== null &&
      typeof data === "object" &&
      data["found"] === true
    ) {
      const tecnico = data["tecnico"] as Record<string, unknown> | undefined;
      if (tecnico && typeof tecnico["tecnico_id"] === "string") {
        session.tecnico_id = tecnico["tecnico_id"];
      }
    }
  }

  if (toolName === "register_tecnico") {
    const data = result.data as Record<string, unknown> | null;
    if (data !== null && typeof data === "object") {
      const id = data["tecnico_id"];
      if (typeof id === "string") {
        session.tecnico_id = id;
      }
    }
  }
}
