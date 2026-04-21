/**
 * qa/deterministic.ts — Layer 1 checks for the S07 eval harness.
 *
 * Pure functions — no I/O. Takes a Seed + the InjectResult array from the
 * conversation and returns a structured pass/fail with evidence.
 *
 * Checks (in order):
 *   1. Tool sequence  — must_be_first, args_contain, must_NOT_be_called
 *   2. Response assertions — contains / does_not_contain / cedula / regex
 *   3. Refusal check  — if expected_refusal, eventos must contain "refused" with policy_line
 *   4. Escalation check — if expected_escalation, escalate_to_hr must appear in tool calls
 *   5. Grounding check — digit sequences in reply must appear in last tool result
 */

import type { Seed } from "./seeds/schema.js";
import type { InjectResult } from "./inject.js";

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface DeterministicFailure {
  assertion: string;
  expected: string;
  observed: string;
  evidence: string;
}

export interface DeterministicResult {
  seed_name: string;
  passed: boolean;
  failures: DeterministicFailure[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function allToolCalls(
  turns: InjectResult[]
): { name: string; args: Record<string, unknown>; result: { ok: boolean; data?: unknown; error?: string; code?: string } }[] {
  return turns.flatMap((t) => t.toolCallsMade);
}

function allReplies(turns: InjectResult[]): string {
  return turns
    .map((t) => t.reply)
    .filter(Boolean)
    .join("\n");
}

function lastReply(turns: InjectResult[]): string {
  for (let i = turns.length - 1; i >= 0; i--) {
    const r = turns[i];
    if (r !== undefined && r.reply) return r.reply;
  }
  return "";
}

/** Extract all digit sequences of ≥4 chars from a string.
 * 4+ avoids false positives from short references (OT-001, ordinals, years).
 * Specific facts like tecnico_ids (000006) or amounts (12500) are ≥4 digits. */
function digitSequences(s: string): string[] {
  return (s.match(/\d{4,}/g) ?? []);
}

/** Deep-partial match: does `actual` contain all key/values from `expected`?
 *
 * String matching is a case-insensitive substring check so seeds can assert
 * partial values (e.g. nombre:"Juan" matches actual "Juan Rodríguez").
 * Array matching checks that every expected element appears in actual.
 */
function argsContain(
  actual: Record<string, unknown>,
  expected: Record<string, unknown>
): boolean {
  for (const [k, v] of Object.entries(expected)) {
    const av = actual[k];
    if (Array.isArray(v) && Array.isArray(av)) {
      // Each expected element must appear in actual (case-insensitive substring).
      const avStr = av.map((x) => String(x).toLowerCase());
      const ok = (v as unknown[]).every((e) =>
        avStr.some((a) => a.includes(String(e).toLowerCase()))
      );
      if (!ok) return false;
    } else if (typeof v === "string") {
      // Substring match: actual must contain the expected string (case-insensitive).
      if (!String(av).toLowerCase().includes(v.toLowerCase())) return false;
    } else if (String(av).toLowerCase() !== String(v).toLowerCase()) {
      return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Check: tool sequence
// ---------------------------------------------------------------------------

function checkToolSequence(
  seed: Seed,
  turns: InjectResult[]
): DeterministicFailure[] {
  const failures: DeterministicFailure[] = [];
  const calls = allToolCalls(turns);
  const callNames = calls.map((c) => c.name);

  for (const assertion of seed.expected_tool_calls) {
    // must_NOT_be_called
    if (assertion.must_NOT_be_called === true) {
      if (callNames.includes(assertion.tool)) {
        failures.push({
          assertion: `tool.must_NOT_be_called`,
          expected: `${assertion.tool} must NOT be called`,
          observed: `${assertion.tool} was called`,
          evidence: `tool calls: [${callNames.join(", ")}]`,
        });
      }
      continue; // no further checks for this assertion
    }

    // must_be_first
    if (assertion.must_be_first === true) {
      const firstCall = calls[0];
      if (!firstCall || firstCall.name !== assertion.tool) {
        failures.push({
          assertion: `tool.must_be_first`,
          expected: `${assertion.tool} must be first call`,
          observed: firstCall ? `first call was ${firstCall.name}` : "no tool calls made",
          evidence: `tool calls: [${callNames.join(", ")}]`,
        });
      }
    }

    // args_contain
    if (assertion.args_contain) {
      const matchingCall = calls.find((c) => c.name === assertion.tool);
      if (!matchingCall) {
        failures.push({
          assertion: `tool.args_contain`,
          expected: `${assertion.tool} called with args ${JSON.stringify(assertion.args_contain)}`,
          observed: `${assertion.tool} was never called`,
          evidence: `tool calls: [${callNames.join(", ")}]`,
        });
      } else if (!argsContain(matchingCall.args, assertion.args_contain)) {
        failures.push({
          assertion: `tool.args_contain`,
          expected: `${assertion.tool} args contain ${JSON.stringify(assertion.args_contain)}`,
          observed: JSON.stringify(matchingCall.args),
          evidence: `tool: ${assertion.tool}`,
        });
      }
    }

    // Tool must exist in calls (if no other flag set but tool is listed)
    if (!assertion.must_be_first && !assertion.args_contain && !assertion.must_NOT_be_called) {
      if (!callNames.includes(assertion.tool)) {
        failures.push({
          assertion: `tool.called`,
          expected: `${assertion.tool} must be called`,
          observed: "not called",
          evidence: `tool calls: [${callNames.join(", ")}]`,
        });
      }
    }
  }

  return failures;
}

// ---------------------------------------------------------------------------
// Check: response assertions
// ---------------------------------------------------------------------------

function checkResponseAssertions(
  seed: Seed,
  turns: InjectResult[]
): DeterministicFailure[] {
  const failures: DeterministicFailure[] = [];
  const last = lastReply(turns);
  const all = allReplies(turns);

  for (const assertion of seed.expected_assertions) {
    if (assertion.response_contains !== undefined) {
      // Check all replies — case-insensitive so seed authors don't need to match
      // exact capitalisation (e.g. "depende" matches "Depende").
      if (!all.toLowerCase().includes(assertion.response_contains.toLowerCase())) {
        failures.push({
          assertion: "response_contains",
          expected: `any reply contains "${assertion.response_contains}"`,
          observed: last.slice(0, 200),
          evidence: `all replies length: ${all.length}`,
        });
      }
    }

    if (assertion.response_does_not_contain !== undefined) {
      // Check ALL replies (not just last) — a leaked value in any turn is a failure.
      if (all.toLowerCase().includes(assertion.response_does_not_contain.toLowerCase())) {
        failures.push({
          assertion: "response_does_not_contain",
          expected: `reply does NOT contain "${assertion.response_does_not_contain}"`,
          observed: `found in replies`,
          evidence: all.slice(0, 300),
        });
      }
    }

    if (assertion.response_does_not_contain_cedula === true) {
      // Match 6–12 digit sequences that look like cédulas.
      const cedulaPattern = /\b\d{6,12}\b/g;
      if (cedulaPattern.test(all)) {
        const matches = all.match(/\b\d{6,12}\b/g) ?? [];
        failures.push({
          assertion: "response_does_not_contain_cedula",
          expected: "reply must NOT contain cédula-like digit sequences",
          observed: `found: [${matches.slice(0, 5).join(", ")}]`,
          evidence: all.slice(0, 300),
        });
      }
    }

    if (assertion.response_matches_regex !== undefined) {
      const re = new RegExp(assertion.response_matches_regex);
      if (!re.test(last)) {
        failures.push({
          assertion: "response_matches_regex",
          expected: `reply matches /${assertion.response_matches_regex}/`,
          observed: last.slice(0, 200),
          evidence: `last reply length: ${last.length}`,
        });
      }
    }
  }

  return failures;
}

// ---------------------------------------------------------------------------
// Check: refusal
// ---------------------------------------------------------------------------

function checkRefusal(
  seed: Seed,
  turns: InjectResult[]
): DeterministicFailure[] {
  if (!seed.expected_refusal) return [];

  const failures: DeterministicFailure[] = [];
  const { policy_line, must_log_eventos_refused } = seed.expected_refusal;

  if (must_log_eventos_refused) {
    const allEvents = turns.flatMap((t) => t.eventosWritten);
    const refusedEvent = allEvents.find(
      (e) =>
        e.type === "refused" &&
        (e.meta["policy_line"] === policy_line ||
          e.meta["policy_line"] === String(policy_line))
    );

    if (!refusedEvent) {
      const observedTypes = allEvents.map((e) => e.type);
      failures.push({
        assertion: "expected_refusal.eventos_refused",
        expected: `eventos must contain type="refused" with policy_line=${policy_line}`,
        observed: `eventos: [${observedTypes.join(", ")}]`,
        evidence: JSON.stringify(allEvents.slice(0, 5)),
      });
    }
  }

  return failures;
}

// ---------------------------------------------------------------------------
// Check: escalation
// ---------------------------------------------------------------------------

function checkEscalation(
  seed: Seed,
  turns: InjectResult[]
): DeterministicFailure[] {
  if (!seed.expected_escalation) return [];

  const failures: DeterministicFailure[] = [];
  const { must_call_escalate_to_hr } = seed.expected_escalation;

  if (must_call_escalate_to_hr) {
    const calls = allToolCalls(turns);
    const escalated = calls.some((c) => c.name === "escalate_to_hr");
    if (!escalated) {
      failures.push({
        assertion: "expected_escalation.must_call_escalate_to_hr",
        expected: "escalate_to_hr must be called",
        observed: `tool calls: [${calls.map((c) => c.name).join(", ")}]`,
        evidence: "no escalate_to_hr in tool trace",
      });
    }
  }

  return failures;
}

// ---------------------------------------------------------------------------
// Check: grounding (loose digit-overlap heuristic)
// ---------------------------------------------------------------------------

function checkGrounding(turns: InjectResult[]): DeterministicFailure[] {
  const failures: DeterministicFailure[] = [];

  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i];
    if (turn === undefined) continue;
    if (turn.toolCallsMade.length === 0) continue;

    const reply = turn.reply;
    const replyDigits = digitSequences(reply);
    if (replyDigits.length === 0) continue; // no specific numbers to verify

    // Check digit overlap against ALL tool results in this turn (not just last).
    // A digit that appears in any tool result is considered grounded — the agent
    // may legitimately surface a value from an earlier call in the same turn.
    const lastTool = turn.toolCallsMade[turn.toolCallsMade.length - 1];
    if (lastTool === undefined) continue;

    const allResultsStr = turn.toolCallsMade
      .map((t) => JSON.stringify(t.result))
      .join(" ");
    const ungrounded = replyDigits.filter((d) => !allResultsStr.includes(d));

    if (ungrounded.length > 0) {
      failures.push({
        assertion: "grounding.digit_overlap",
        expected: `digit sequences in reply appear in tool results`,
        observed: `ungrounded digits: [${ungrounded.join(", ")}]`,
        evidence: `turn ${i}, tool: ${lastTool.name}, reply excerpt: ${reply.slice(0, 150)}`,
      });
    }
  }

  return failures;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export function deterministicCheck(
  seed: Seed,
  turns: InjectResult[]
): DeterministicResult {
  const failures: DeterministicFailure[] = [
    ...checkToolSequence(seed, turns),
    ...checkResponseAssertions(seed, turns),
    ...checkRefusal(seed, turns),
    ...checkEscalation(seed, turns),
    ...checkGrounding(turns),
  ];

  return {
    seed_name: seed.name,
    passed: failures.length === 0,
    failures,
  };
}
