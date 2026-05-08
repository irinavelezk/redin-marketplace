// mark_candidate_withdrawn — flip candidate_state to 'withdrawn' + record reason.
// Idempotent. Triggered when:
//   - worker refuses to provide cedula (reason='no_cedula_provided')
//   - worker stops responding (reason='no_response')
//   - worker explicitly opts out (reason='opted_out')
// State machine guard: only screening can flip to withdrawn (per
// LEGAL_TRANSITIONS in dossier-types.ts). Already-terminal states return
// noop=true with prior_state echoed.

import type { ToolContext } from "./context";
import { ok, err, type ToolResult } from "./types";
import { recordEvent } from "./events";
import type {
  MarkCandidateWithdrawnInput,
  MarkCandidateWithdrawnOutput,
  CandidateState,
  WithdrawalReason,
} from "@redin/shared/dossier-types";

const VALID_REASONS: readonly WithdrawalReason[] = [
  "no_cedula_provided",
  "no_response",
  "opted_out",
  "duplicate_phone",
  "other",
] as const;

export async function markCandidateWithdrawn(
  ctx: ToolContext,
  input: MarkCandidateWithdrawnInput
): Promise<ToolResult<MarkCandidateWithdrawnOutput>> {
  if (!input.tecnico_id?.trim()) {
    return err("tecnico_id required", { code: "invalid_input" });
  }
  if (!input.reason || !VALID_REASONS.includes(input.reason as WithdrawalReason)) {
    return err(
      `reason must be one of: ${VALID_REASONS.join(", ")}`,
      { code: "invalid_input" }
    );
  }

  const { data: tec, error: lookupErr } = await ctx.supabase
    .from("tecnicos_extended")
    .select("tecnico_id, candidate_state, withdrawal_reason")
    .eq("tecnico_id", input.tecnico_id)
    .maybeSingle();
  if (lookupErr) {
    return err(`db error: ${lookupErr.message}`, {
      code: "db_error",
      retryable: true,
    });
  }
  if (!tec) return err("tecnico_id not found", { code: "not_found" });

  const priorState = tec.candidate_state as CandidateState;

  // Idempotent: already withdrawn -> noop. Echo current reason.
  if (priorState === "withdrawn") {
    return ok({
      tecnico_id: tec.tecnico_id,
      prior_state: priorState,
      resulting_state: "withdrawn",
      noop: true,
    });
  }

  // Terminal states (revoked) cannot be withdrawn — noop with prior preserved.
  if (priorState === "revoked") {
    return ok({
      tecnico_id: tec.tecnico_id,
      prior_state: priorState,
      resulting_state: priorState,
      noop: true,
    });
  }

  // Approved / pending / needs_call / rejected — agent shouldn't be calling
  // mark_candidate_withdrawn on these. Refuse politely, no state change.
  if (priorState !== "screening") {
    return err(
      `cannot withdraw from state '${priorState}' — only 'screening' can flip to 'withdrawn'`,
      { code: "illegal_transition" }
    );
  }

  const { error: updateErr } = await ctx.supabase
    .from("tecnicos_extended")
    .update({
      candidate_state: "withdrawn",
      withdrawal_reason: input.reason,
    })
    .eq("tecnico_id", tec.tecnico_id);
  if (updateErr) {
    return err(`update failed: ${updateErr.message}`, {
      code: "db_error",
      retryable: true,
    });
  }

  await recordEvent(ctx, {
    type: "candidate_withdrawn",
    entity_id: tec.tecnico_id,
    actor: ctx.defaultActor,
    meta: {
      reason: input.reason,
      notes: input.notes ?? null,
      prior_state: priorState,
    },
  });

  return ok({
    tecnico_id: tec.tecnico_id,
    prior_state: priorState,
    resulting_state: "withdrawn",
    noop: false,
  });
}
