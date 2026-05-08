// HR qualification queue — workers with candidate_state in (pending, needs_call).
// Approve / reject / schedule call. Each action posts to submitDecision in
// @/lib/decisions, which writes a candidate_decisions row + flips state via
// compare-and-set + enqueues WhatsApp + records the agreement metric.
//
// Commit 1 keeps the existing card layout + minimal queries; commit 2 rebuilds
// the §3.5 UX (recommendation badge, raw confidence, why-expand, sort,
// hr_notes thread). The dossier_id captured here flows into submitDecision so
// the agreement signal is preserved as soon as the queue starts surfacing
// dossier-bearing candidates.

import { serverClientBoundToCookies, serviceClient } from "@/lib/supabase-server";
import { submitDecision } from "@/lib/decisions";
import type { CandidateState } from "@redin/shared";
import { redirect } from "next/navigation";
import Link from "next/link";

export const dynamic = "force-dynamic";

interface RegisteredMeta {
  nombre?: string;
  ciudad?: string;
  especialidades?: string[];
  modalidad?: string;
}

interface ReviewMeta {
  summary?: string;
}

function parseRegisteredMeta(meta: unknown): RegisteredMeta {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return {};
  const m = meta as Record<string, unknown>;
  const out: RegisteredMeta = {};
  if (typeof m.nombre === "string") out.nombre = m.nombre;
  if (typeof m.ciudad === "string") out.ciudad = m.ciudad;
  if (Array.isArray(m.especialidades)) {
    out.especialidades = m.especialidades.filter((x): x is string => typeof x === "string");
  }
  if (typeof m.modalidad === "string") out.modalidad = m.modalidad;
  return out;
}

function parseReviewMeta(meta: unknown): ReviewMeta {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return {};
  const m = meta as Record<string, unknown>;
  if (typeof m.summary === "string") return { summary: m.summary };
  return {};
}

const CANDIDATE_STATE_CLASS: Partial<Record<CandidateState, string>> = {
  pending: "text-amber-600",
  needs_call: "text-violet-700 font-medium",
};

export default async function HrQualificationQueuePage() {
  const auth = serverClientBoundToCookies();
  const { data: userData } = await auth.auth.getUser();
  if (!userData.user) redirect("/login");

  const supa = serviceClient();

  // Per contract §3.5: queue surfaces candidate_state ∈ {pending, needs_call}
  // only. screening = mid-conversation; approved/rejected/withdrawn/revoked =
  // out of HR queue.
  const { data: tecnicos } = await supa
    .from("tecnicos_extended")
    .select("*")
    .in("candidate_state", ["pending", "needs_call"])
    .order("onboarded_at", { ascending: false })
    .limit(100);

  const ids = (tecnicos ?? []).map((t) => t.tecnico_id);

  // Fetch related context per tecnico in parallel.
  const [regEventsRes, reviewEventsRes, dossiersRes] = ids.length
    ? await Promise.all([
        supa
          .from("eventos")
          .select("entity_id, meta, created_at")
          .eq("type", "tecnico_registered")
          .in("entity_id", ids)
          .order("created_at", { ascending: false }),
        supa
          .from("eventos")
          .select("entity_id, meta, created_at")
          .eq("type", "qualification_review_requested")
          .in("entity_id", ids)
          .order("created_at", { ascending: false }),
        supa
          .from("candidate_dossiers")
          .select("id, tecnico_id, tono_recommendation, tono_confidence, created_at")
          .in("tecnico_id", ids)
          .order("created_at", { ascending: false }),
      ])
    : [{ data: [] }, { data: [] }, { data: [] }];

  const regByTec = new Map<string, RegisteredMeta>();
  for (const e of regEventsRes.data ?? []) {
    if (!e.entity_id || regByTec.has(e.entity_id)) continue;
    regByTec.set(e.entity_id, parseRegisteredMeta(e.meta));
  }
  const reviewByTec = new Map<string, ReviewMeta>();
  for (const e of reviewEventsRes.data ?? []) {
    if (!e.entity_id || reviewByTec.has(e.entity_id)) continue;
    reviewByTec.set(e.entity_id, parseReviewMeta(e.meta));
  }
  // Latest dossier per tecnico_id (the one HR is reviewing — captured in the
  // form so submitDecision can snapshot tono_recommendation_at_decision_time).
  const latestDossierByTec = new Map<
    string,
    { id: string; tono_recommendation: string; tono_confidence: number }
  >();
  for (const d of dossiersRes.data ?? []) {
    if (latestDossierByTec.has(d.tecnico_id)) continue;
    latestDossierByTec.set(d.tecnico_id, {
      id: d.id,
      tono_recommendation: d.tono_recommendation,
      tono_confidence: Number(d.tono_confidence),
    });
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-slate-900">Cola de calificación</h1>
        <div className="flex items-center gap-3">
          <Link href="/hr/tecnicos" className="text-sm text-slate-600 hover:text-slate-900">
            Técnicos →
          </Link>
          <Link href="/hr/pipeline" className="text-sm text-slate-500 hover:text-slate-700">
            Pipeline →
          </Link>
        </div>
      </div>
      <p className="text-sm text-slate-600">
        Técnicos esperando aprobación. <strong>pending</strong> = Toño ya entregó
        el dossier, listo para HR. <strong>needs_call</strong> = pediste una
        llamada; vuelve aquí después de hacerla y aprueba o rechaza.
      </p>

      {(tecnicos ?? []).length === 0 ? (
        <div className="card p-4 text-sm text-slate-500">
          No hay técnicos en revisión. Vuelve cuando alguien nuevo se registre.
        </div>
      ) : (
        <ul className="space-y-3">
          {(tecnicos ?? []).map((tec) => {
            const reg = regByTec.get(tec.tecnico_id);
            const review = reviewByTec.get(tec.tecnico_id);
            const dossier = latestDossierByTec.get(tec.tecnico_id);
            const stateClass =
              CANDIDATE_STATE_CLASS[tec.candidate_state] ?? "text-slate-600";
            return (
              <li key={tec.tecnico_id} className="card p-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="font-medium text-slate-900">
                      {reg?.nombre ?? "(sin nombre)"} ·{" "}
                      <span className="text-slate-500 font-normal">
                        {reg?.ciudad ?? "—"}
                      </span>
                    </div>
                    <div className="text-xs text-slate-500 mt-0.5">
                      {tec.phone} · onboarded{" "}
                      {new Date(tec.onboarded_at).toLocaleString("es-CO")} ·{" "}
                      <span className={stateClass}>{tec.candidate_state}</span>
                    </div>
                    {reg?.especialidades && reg.especialidades.length > 0 && (
                      <div className="text-sm text-slate-700 mt-2">
                        <span className="text-slate-500">Especialidades: </span>
                        {reg.especialidades.join(", ")}
                        {reg.modalidad && (
                          <span className="text-slate-500"> · {reg.modalidad}</span>
                        )}
                      </div>
                    )}
                    {dossier && (
                      <div className="text-xs text-slate-600 mt-2">
                        Toño sugiere{" "}
                        <span className="font-medium text-slate-800">
                          {dossier.tono_recommendation}
                        </span>{" "}
                        ({dossier.tono_confidence.toFixed(2)})
                      </div>
                    )}
                    {review?.summary && (
                      <div className="text-sm text-slate-700 mt-2 border-l-2 border-amber-300 pl-3">
                        <div className="text-xs uppercase tracking-wide text-slate-500 mb-0.5">
                          Toño
                        </div>
                        {review.summary}
                      </div>
                    )}
                  </div>
                  <div className="flex flex-col gap-1 shrink-0">
                    <form action={submitDecision}>
                      <input type="hidden" name="tecnico_id" value={tec.tecnico_id} />
                      <input type="hidden" name="prior_state" value={tec.candidate_state} />
                      <input type="hidden" name="dossier_id" value={dossier?.id ?? ""} />
                      <input type="hidden" name="decision" value="approve" />
                      <button
                        type="submit"
                        className="text-xs bg-emerald-600 hover:bg-emerald-700 text-white rounded-md px-3 py-1 w-32"
                      >
                        Aprobar
                      </button>
                    </form>
                    {tec.candidate_state === "pending" && (
                      <form action={submitDecision}>
                        <input type="hidden" name="tecnico_id" value={tec.tecnico_id} />
                        <input type="hidden" name="prior_state" value={tec.candidate_state} />
                        <input type="hidden" name="dossier_id" value={dossier?.id ?? ""} />
                        <input type="hidden" name="decision" value="schedule_call" />
                        <button
                          type="submit"
                          className="text-xs bg-amber-500 hover:bg-amber-600 text-white rounded-md px-3 py-1 w-32"
                        >
                          Pedir llamada
                        </button>
                      </form>
                    )}
                    {tec.candidate_state === "needs_call" && (
                      <form action={submitDecision}>
                        <input type="hidden" name="tecnico_id" value={tec.tecnico_id} />
                        <input type="hidden" name="prior_state" value={tec.candidate_state} />
                        <input type="hidden" name="dossier_id" value={dossier?.id ?? ""} />
                        <input type="hidden" name="decision" value="unschedule_call" />
                        <button
                          type="submit"
                          className="text-xs bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-md px-3 py-1 w-32"
                        >
                          Quitar llamada
                        </button>
                      </form>
                    )}
                    <form action={submitDecision}>
                      <input type="hidden" name="tecnico_id" value={tec.tecnico_id} />
                      <input type="hidden" name="prior_state" value={tec.candidate_state} />
                      <input type="hidden" name="dossier_id" value={dossier?.id ?? ""} />
                      <input type="hidden" name="decision" value="reject" />
                      <button
                        type="submit"
                        className="text-xs border border-slate-300 hover:bg-slate-50 text-slate-700 rounded-md px-3 py-1 w-32"
                      >
                        Rechazar
                      </button>
                    </form>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
