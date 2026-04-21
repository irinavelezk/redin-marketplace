/**
 * Zod schema for Redin eval seed YAML files.
 *
 * Every file under qa/seeds/journeys/, qa/seeds/refusals/, qa/seeds/redteam/
 * must parse and validate against `Seed` without error.
 *
 * Runner (S07) imports parseSeedYaml() to load seeds at eval time.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Sub-schemas
// ---------------------------------------------------------------------------

/**
 * Asserts a tool call that MUST (or MUST NOT) appear in the agent's tool-call
 * trace for this turn sequence.
 *
 * - `tool`            — tool name from the 9 Toño tools in tools/src/schemas.ts
 * - `must_be_first`   — this tool must be the very first call in the session turn
 * - `args_contain`    — the actual args passed to the tool must contain these
 *                       key/value pairs (partial match, deep equality per key)
 * - `must_NOT_be_called` — when true, fail if this tool is called at all
 */
export const ToolCallAssertion = z.object({
  tool: z.enum([
    "identify_user",
    "register_tecnico",
    "read_pending_ots",
    "create_postulacion",
    "read_my_postulaciones",
    "read_my_contratos",
    "upload_documento",
    "escalate_to_hr",
    "log_event",
  ]),
  must_be_first: z.boolean().optional(),
  args_contain: z.record(z.string(), z.unknown()).optional(),
  must_NOT_be_called: z.boolean().optional(),
});

export type ToolCallAssertion = z.infer<typeof ToolCallAssertion>;

/**
 * Natural-language / regex assertions on Toño's text responses.
 *
 * - `response_contains`              — substring that must appear in the response
 * - `response_does_not_contain`      — substring that must NOT appear
 * - `response_does_not_contain_cedula` — when true, fail if the response matches
 *                                        /\b\d{6,12}\b/ (cédula pattern)
 * - `response_matches_regex`         — ECMAScript regex string the response must match
 */
export const ResponseAssertion = z.object({
  response_contains: z.string().optional(),
  response_does_not_contain: z.string().optional(),
  response_does_not_contain_cedula: z.boolean().optional(),
  response_matches_regex: z.string().optional(),
});

export type ResponseAssertion = z.infer<typeof ResponseAssertion>;

// ---------------------------------------------------------------------------
// DB fixture literals consumed by the eval runner to seed Supabase test state
// ---------------------------------------------------------------------------

export const DB_FIXTURE = z.enum([
  "tecnico_not_registered",
  "tecnico_registered_bogota_electrico",
  "tecnico_registered_cali_plomero",
  "tecnico_with_pending_postulacion",
  "tecnico_with_signed_contract",
  "open_ot_bogota_electrico",
  "open_ot_neiva_plomero",
  "multiple_open_ots_bogota", // triggers truncation (≥20 rows)
]);

export type DBFixture = z.infer<typeof DB_FIXTURE>;

// ---------------------------------------------------------------------------
// Root seed schema
// ---------------------------------------------------------------------------

export const Seed = z.object({
  /**
   * Unique identifier — must match the filename without .yaml extension.
   */
  name: z.string().min(1),

  /**
   * PRD section this seed exercises, e.g. "§9.1", "§19 refusal-3", "§21 mode-7".
   */
  prd_ref: z.string().min(1),

  /**
   * Broad category — drives which sub-directory the seed lives in.
   */
  category: z.enum(["journey", "refusal", "redteam"]),

  /**
   * One-sentence human description of what this seed tests.
   */
  description: z.string().min(1),

  /**
   * Optional pre-seed DB state. Runner sets up these fixtures before the
   * conversation starts and tears them down after.
   */
  db_fixtures: z.array(DB_FIXTURE).default([]),

  /**
   * Ordered list of user messages sent to Toño in sequence.
   * Min 1 utterance. Colombian Spanish "tú" register.
   */
  user_utterances: z.array(z.string()).min(1),

  /**
   * Ordered list of tool-call assertions. The deterministic layer checks
   * that the tool trace matches these in order (subsequence match —
   * extra calls between expected ones are allowed unless must_NOT_be_called).
   */
  expected_tool_calls: z.array(ToolCallAssertion).default([]),

  /**
   * Response-level assertions checked against the LAST assistant message
   * produced by the conversation, unless the assertion is about a specific turn
   * (runners may check all turns for does_not_contain assertions).
   */
  expected_assertions: z.array(ResponseAssertion).default([]),

  /**
   * If set, the runner verifies Toño refused and logged eventos{type:"refused"}.
   */
  expected_refusal: z
    .object({
      policy_line: z.number().int().min(1).max(6),
      must_log_eventos_refused: z.boolean().default(true),
    })
    .optional(),

  /**
   * If set, the runner verifies escalate_to_hr was called and the correct
   * escalation trigger is referenced in the event log.
   */
  expected_escalation: z
    .object({
      trigger: z.number().int().min(1).max(5),
      must_call_escalate_to_hr: z.boolean().default(true),
    })
    .optional(),
});

export type Seed = z.infer<typeof Seed>;

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

/**
 * Parse and validate a raw YAML string (already parsed to JS object by caller)
 * against the Seed schema. Throws ZodError with a clear message on failure.
 *
 * Usage:
 *   import yaml from "js-yaml";
 *   import { parseSeedYaml } from "./schema.js";
 *   const seed = parseSeedYaml(yaml.load(fs.readFileSync(file, "utf8")));
 */
export function parseSeedYaml(raw: unknown): Seed {
  const result = Seed.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  [${i.path.join(".")}] ${i.message}`)
      .join("\n");
    throw new Error(`Seed validation failed:\n${issues}`);
  }
  return result.data;
}
