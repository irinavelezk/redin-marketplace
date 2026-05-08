// HR decision server actions — submitDecision (writes a candidate_decisions row,
// flips candidate_state via compare-and-set, fires side effects) and
// appendHrNote (appends to hr_notes thread).
//
// Atomicity strategy (per docs/architecture/onboarding-contracts.md §5.1):
//
//   1. CAS UPDATE on tecnicos_extended FIRST. If the row's candidate_state no
//      longer matches the form's prior_state, return stale_click — the user's
//      view is stale; do NOT write any audit rows.
//   2. Latest-dossier sanity: re-read latest candidate_dossiers row for the
//      tecnico. If the form's dossier_id != latest, ROLL BACK state via reverse
//      CAS and return stale_dossier. The tono_recommendation_at_decision_time
//      snapshot would otherwise be against a dossier HR never saw.
//   3. Eventos before candidate_decisions: write the eventos row first so that
//      a partial-failure on the candidate_decisions INSERT still leaves a
//      reconstructable audit trail.
//   4. Side effects last: enqueue WhatsApp via outbound_messages queue.
//
// Stream A's submit_candidate_dossier and the deprecated set_qualification_state
// shim use a similar non-transactional sequence — we match that risk profile
// rather than introducing a Postgres RPC.

"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  computeAgreedWithTono,
  type CandidateState,
  type HrAction,
  type TonoRecommendation,
} from "@redin/shared";
import { enqueueWhatsApp } from "@/lib/notify";
import { serverClientBoundToCookies, serviceClient } from "@/lib/supabase-server";

// ---------------------------------------------------------------------------
// State transition table
// ---------------------------------------------------------------------------

// (prior_state, decision) → resulting_state. Mirrors LEGAL_TRANSITIONS in
// shared/src/dossier-types.ts plus the action vocabulary; expressed flat here
// so submitDecision can resolve in O(1) without re-deriving from the action map.
const RESULTING_STATE: Partial<
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

// ---------------------------------------------------------------------------
// submitDecision
// ---------------------------------------------------------------------------

export interface SubmitDecisionResult {
  ok: boolean;
  code?: "stale_click" | "stale_dossier" | "illegal_transition" | "not_found" | "db_error";
  message?: string;
}

const HR_ACTIONS: readonly HrAction[] = [
  "approve",
  "reject",
  "schedule_call",
  "unschedule_call",
  "revoke",
  "reopen",
];

const CANDIDATE_STATES: readonly CandidateState[] = [
  "screening",
  "pending",
  "needs_call",
  "approved",
  "rejected",
  "withdrawn",
  "revoked",
];

export async function submitDecision(formData: FormData): Promise<void> {
  const auth = serverClientBoundToCookies();
  const { data: userData } = await auth.auth.getUser();
  if (!userData.user) redirect("/login");
  const hrEmail = userData.user.email ?? userData.user.id;
  const decidedBy = `hr:${hrEmail}`;

  const tecnicoId = formData.get("tecnico_id");
  const decision = formData.get("decision");
  const priorStateRaw = formData.get("prior_state");
  const dossierIdRaw = formData.get("dossier_id");
  const hrReasoningRaw = formData.get("hr_reasoning");

  if (typeof tecnicoId !== "string" || !tecnicoId.trim()) return;
  if (typeof decision !== "string" || !HR_ACTIONS.includes(decision as HrAction)) return;
  if (typeof priorStateRaw !== "string" || !CANDIDATE_STATES.includes(priorStateRaw as CandidateState)) return;

  const action = decision as HrAction;
  const priorState = priorStateRaw as CandidateState;
  const formDossierId =
    typeof dossierIdRaw === "string" && dossierIdRaw.length > 0 ? dossierIdRaw : null;
  const hrReasoning =
    typeof hrReasoningRaw === "string" && hrReasoningRaw.trim().length > 0
      ? hrReasoningRaw.trim()
      : null;

  const resultingState = computeResultingState(priorState, action);
  if (!resultingState) {
    console.error("submitDecision illegal_transition", { tecnicoId, priorState, action });
    return;
  }

  const supa = serviceClient();

  // -------- 1. CAS UPDATE on tecnicos_extended ---------------------------
  // Compare-and-set: only flip if candidate_state still matches prior_state.
  // Side-effect flags ride along in the same UPDATE to keep them atomic with
  // the state flip.
  const patch: {
    candidate_state: CandidateState;
    appsheet_sync_pending?: boolean;
    appsheet_delete_pending?: boolean;
    withdrawal_reason?: string | null;
  } = { candidate_state: resultingState };
  if (action === "approve") patch.appsheet_sync_pending = true;
  if (action === "revoke") patch.appsheet_delete_pending = true;
  if (action === "reopen") patch.withdrawal_reason = null;

  const { data: casRows, error: casErr } = await supa
    .from("tecnicos_extended")
    .update(patch)
    .eq("tecnico_id", tecnicoId)
    .eq("candidate_state", priorState)
    .select("tecnico_id, phone");
  if (casErr) {
    console.error("submitDecision CAS failed", { tecnicoId, error: casErr.message });
    return;
  }
  if (!casRows || casRows.length === 0) {
    // Stale click — another HR action moved the row; the user must refresh.
    console.warn("submitDecision stale_click", { tecnicoId, priorState, action });
    revalidatePath("/hr/qualification-queue");
    revalidatePath(`/hr/tecnicos/${tecnicoId}`);
    return;
  }
  const phone = casRows[0]!.phone;

  // -------- 2. Latest-dossier sanity check -------------------------------
  // Only when the form supplied a dossier_id (decision-from-queue paths).
  // Revoke/reopen don't reference a dossier; skip the check.
  let tonoRecAtDecision: TonoRecommendation | null = null;
  if (formDossierId) {
    const { data: latest } = await supa
      .from("candidate_dossiers")
      .select("id, tono_recommendation")
      .eq("tecnico_id", tecnicoId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!latest || latest.id !== formDossierId) {
      // Dossier raced — a newer dossier was submitted between render and submit.
      // Roll back state via reverse CAS + clear the side-effect flags.
      const rollback: {
        candidate_state: CandidateState;
        appsheet_sync_pending?: boolean;
        appsheet_delete_pending?: boolean;
        withdrawal_reason?: string | null;
      } = { candidate_state: priorState };
      if (action === "approve") rollback.appsheet_sync_pending = false;
      if (action === "revoke") rollback.appsheet_delete_pending = false;
      const { error: rbErr } = await supa
        .from("tecnicos_extended")
        .update(rollback)
        .eq("tecnico_id", tecnicoId)
        .eq("candidate_state", resultingState);
      if (rbErr) {
        console.error("submitDecision rollback failed (data inconsistency)", {
          tecnicoId,
          error: rbErr.message,
        });
      }
      console.warn("submitDecision stale_dossier", {
        tecnicoId,
        formDossierId,
        latestDossierId: latest?.id ?? null,
      });
      revalidatePath("/hr/qualification-queue");
      return;
    }
    tonoRecAtDecision = latest.tono_recommendation as TonoRecommendation;
  }

  // -------- 3. Compute agreed_with_tono ---------------------------------
  const agreedWithTono = computeAgreedWithTono(action, tonoRecAtDecision);

  // -------- 4. Eventos BEFORE candidate_decisions -----------------------
  // Reconstructable audit if the candidate_decisions INSERT later fails.
  const { error: evErr } = await supa.from("eventos").insert({
    type: "hr_decision",
    entity_id: tecnicoId,
    actor: decidedBy,
    meta: {
      decision: action,
      prior_state: priorState,
      resulting_state: resultingState,
      dossier_id: formDossierId,
      tono_recommendation_at_decision_time: tonoRecAtDecision,
      agreed_with_tono: agreedWithTono,
      hr_reasoning: hrReasoning,
    },
  });
  if (evErr) {
    console.error("submitDecision eventos insert failed", {
      tecnicoId,
      error: evErr.message,
    });
    // Don't return — the state has already flipped. Try to log the decision
    // anyway. Both eventos + candidate_decisions failing is rare (DB outage);
    // the operator-facing impact is identical to a single failure.
  }

  // -------- 5. candidate_decisions row ---------------------------------
  const { error: decErr } = await supa.from("candidate_decisions").insert({
    tecnico_id: tecnicoId,
    dossier_id: formDossierId,
    decision: action,
    resulting_state: resultingState,
    prior_state: priorState,
    tono_recommendation_at_decision_time: tonoRecAtDecision,
    agreed_with_tono: agreedWithTono,
    hr_reasoning: hrReasoning,
    decided_by: decidedBy,
  });
  if (decErr) {
    console.error("submitDecision candidate_decisions insert failed", {
      tecnicoId,
      error: decErr.message,
    });
    // Audit trail still recoverable from eventos meta payload above.
  }

  // -------- 6. Side effects: WhatsApp -----------------------------------
  if (phone) {
    let body: string | null = null;
    if (action === "approve") {
      body =
        "Listo — tu perfil quedó aprobado. Ya puedes postularte a los trabajos que te muestre. Cuando entre algo que te sirva, te aviso.";
    } else if (action === "reject") {
      body =
        "Hola, revisamos tu perfil y por ahora no podemos seguir adelante. Si quieres conversarlo, puedes responder y te contactamos.";
    } else if (action === "schedule_call") {
      body =
        "Queremos hacerte una llamada corta para conocerte mejor antes de avanzar. Pronto te contactamos para coordinar.";
    }
    // No outbound on unschedule_call / revoke / reopen (per contract §2.3 + §6.1).
    if (body) {
      await enqueueWhatsApp(supa, {
        phone,
        body,
        meta: {
          kind: "hr_decision",
          tecnico_id: tecnicoId,
          decision: action,
          to_state: resultingState,
        },
      });
    }
  }

  revalidatePath("/hr/qualification-queue");
  revalidatePath(`/hr/tecnicos/${tecnicoId}`);
  revalidatePath("/hr/tecnicos");
}

// ---------------------------------------------------------------------------
// appendHrNote — append-only note thread per worker
// ---------------------------------------------------------------------------

export async function appendHrNote(formData: FormData): Promise<void> {
  const auth = serverClientBoundToCookies();
  const { data: userData } = await auth.auth.getUser();
  if (!userData.user) redirect("/login");
  const hrEmail = userData.user.email ?? userData.user.id;

  const tecnicoId = formData.get("tecnico_id");
  const bodyRaw = formData.get("body");
  if (typeof tecnicoId !== "string" || !tecnicoId.trim()) return;
  if (typeof bodyRaw !== "string") return;
  const body = bodyRaw.trim();
  if (body.length === 0 || body.length > 2000) return;

  const supa = serviceClient();

  // Pin the note to the latest dossier_id when one exists, so the timeline
  // groups commentary near the dossier it's about. NULL is fine — agent might
  // not have submitted a dossier yet (e.g. a needs_call note pre-screening).
  const { data: latest } = await supa
    .from("candidate_dossiers")
    .select("id")
    .eq("tecnico_id", tecnicoId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const { error } = await supa.from("hr_notes").insert({
    tecnico_id: tecnicoId,
    dossier_id: latest?.id ?? null,
    body,
    hr_user: `hr:${hrEmail}`,
  });
  if (error) {
    console.error("appendHrNote insert failed", { tecnicoId, error: error.message });
    return;
  }

  revalidatePath("/hr/qualification-queue");
  revalidatePath(`/hr/tecnicos/${tecnicoId}`);
}
