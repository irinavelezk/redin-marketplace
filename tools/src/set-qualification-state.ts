// set_qualification_state — Toño signals HR that a worker has enough context
// gathered to be reviewed. Mechanical: writes the column + logs an event with
// the agent's distilled summary. HR-only states (qualified / rejected / needs_call)
// are intentionally rejected here — those flips happen from the dashboard.

import type { ToolContext } from "./context";
import { recordEvent } from "./events";
import type {
  SetQualificationStateInput,
  SetQualificationStateOutput,
  ToolResult,
} from "./types";
import { err, ok } from "./types";

const AGENT_ALLOWED_STATES = new Set(["needs_review"]);
const HR_TERMINAL_STATES = new Set(["qualified", "rejected", "needs_call"]);

export async function setQualificationState(
  ctx: ToolContext,
  input: SetQualificationStateInput
): Promise<ToolResult<SetQualificationStateOutput>> {
  if (!input.tecnico_id?.trim()) {
    return err("tecnico_id required", { code: "invalid_input" });
  }
  if (!AGENT_ALLOWED_STATES.has(input.state)) {
    return err(
      `state '${input.state}' is HR-only; agent may only set 'needs_review'`,
      { code: "invalid_input" }
    );
  }
  const summary = (input.summary ?? "").trim();
  if (summary.length === 0) {
    return err("summary required so HR knows what you gathered", {
      code: "invalid_input",
    });
  }

  const { data: tec, error: lookupErr } = await ctx.supabase
    .from("tecnicos_extended")
    .select("tecnico_id, qualification_state")
    .eq("tecnico_id", input.tecnico_id)
    .maybeSingle();
  if (lookupErr) {
    return err(`db error: ${lookupErr.message}`, { code: "db_error", retryable: true });
  }
  if (!tec) return err("tecnico_id not found", { code: "not_found" });

  // HR has the final say. If they already decided, the agent's request is a no-op.
  if (HR_TERMINAL_STATES.has(tec.qualification_state)) {
    return ok({
      tecnico_id: tec.tecnico_id,
      state: "already_decided",
      prior_state: tec.qualification_state,
    });
  }

  // Idempotent: re-requesting review while already in needs_review is fine —
  // we still log the new summary so HR sees the latest distillation.
  const { error: updateErr } = await ctx.supabase
    .from("tecnicos_extended")
    .update({ qualification_state: "needs_review" })
    .eq("tecnico_id", tec.tecnico_id);
  if (updateErr) {
    return err(`update failed: ${updateErr.message}`, {
      code: "db_error",
      retryable: true,
    });
  }

  await recordEvent(ctx, {
    type: "qualification_review_requested",
    entity_id: tec.tecnico_id,
    actor: input.actor ?? ctx.defaultActor,
    meta: {
      prior_state: tec.qualification_state,
      summary,
    },
  });

  return ok({ tecnico_id: tec.tecnico_id, state: "needs_review" });
}
