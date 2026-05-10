// Pure state-transition table for HR decisions. NO "use server" directive —
// exports are sync helpers that decisions.ts (Server Actions) imports
// internally. Splitting this out is a Next.js requirement: a "use server"
// module may only export async functions.
//
// Source-of-truth: docs/architecture/onboarding-contracts.md §2.2.

import type { CandidateState, HrAction } from "@redin/shared";

// (prior_state, decision) → resulting_state. Mirrors LEGAL_TRANSITIONS in
// shared/src/dossier-types.ts plus the action vocabulary; expressed flat here
// so submitDecision can resolve in O(1).
export const RESULTING_STATE: Partial<
  Record<CandidateState, Partial<Record<HrAction, CandidateState>>>
> = {
  pending: {
    approve: "approved",
    reject: "rejected",
    schedule_call: "needs_call",
  },
  needs_call: {
    approve: "approved",
    reject: "rejected",
    unschedule_call: "pending",
  },
  approved: {
    revoke: "revoked",
  },
  rejected: {
    reopen: "screening",
  },
  withdrawn: {
    reopen: "screening",
  },
};

export function computeResultingState(
  prior: CandidateState,
  action: HrAction
): CandidateState | null {
  return RESULTING_STATE[prior]?.[action] ?? null;
}
