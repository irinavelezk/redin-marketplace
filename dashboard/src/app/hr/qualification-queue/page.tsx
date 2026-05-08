// HR qualification queue — workers with candidate_state in (pending, needs_call).
// Per docs/architecture/onboarding-contracts.md §3.5 (graduated autonomy):
//   1. Recommendation badge (green/red/amber)
//   2. Raw confidence (0.78, NOT bucketed)
//   3. "why?" expand revealing tono_reasoning + gaps
//   4. Deterministic sort: needs_call rows → pending+recommend_call FIFO
//      → pending+recommend_approve by confidence DESC → pending+recommend_reject
//      by confidence DESC
//   5. One-click decisions are still HR's: decided_by = hr:<email>, never
//      "[Toño-approved]" attribution.
//   6. HR can disagree with one click — agreed_with_tono captures divergence.
//   7. hr_reasoning textarea (optional, encouraged when diverging from Toño).
//
// Plus per §5.2: hr_notes thread per candidate, append-only, reverse-chronological.

import { serverClientBoundToCookies, serviceClient } from "@/lib/supabase-server";
import { submitDecision, appendHrNote } from "@/lib/decisions";
import type { CandidateState, TonoRecommendation } from "@redin/shared";
import { redirect } from "next/navigation";
import Link from "next/link";

export const dynamic = "force-dynamic";

interface RegisteredMeta {
  nombre?: string;
  ciudad?: string;
  especialidades?: string[];
  modalidad?: string;
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

interface DossierSummary {
  id: string;
  tono_recommendation: TonoRecommendation;
  tono_confidence: number;
  tono_reasoning: string;
  cedula: string;
  ciudad_base: string | null;
  categorias: string[];
  subcategorias: string[];
  gaps: string[];
  created_at: string;
}

interface DossierPayloadShape {
  ciudad_base?: unknown;
  categorias_principales?: unknown;
  subcategorias?: unknown;
  gaps?: unknown;
}

function summarizeDossierPayload(payload: unknown): {
  ciudad_base: string | null;
  categorias: string[];
  subcategorias: string[];
  gaps: string[];
} {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { ciudad_base: null, categorias: [], subcategorias: [], gaps: [] };
  }
  const p = payload as DossierPayloadShape;
  const ciudad =
    typeof p.ciudad_base === "string" ? (p.ciudad_base as string) : null;
  const cats = Array.isArray(p.categorias_principales)
    ? (p.categorias_principales as unknown[]).filter((x): x is string => typeof x === "string")
    : [];
  const subs = Array.isArray(p.subcategorias)
    ? (p.subcategorias as unknown[]).filter((x): x is string => typeof x === "string")
    : [];
  const gaps = Array.isArray(p.gaps)
    ? (p.gaps as unknown[]).filter((x): x is string => typeof x === "string")
    : [];
  return { ciudad_base: ciudad, categorias: cats, subcategorias: subs, gaps };
}

function recommendationBadge(rec: TonoRecommendation): {
  label: string;
  className: string;
} {
  switch (rec) {
    case "recommend_approve":
      return {
        label: "Toño sugiere aprobar",
        className: "bg-emerald-100 text-emerald-800 border-emerald-300",
      };
    case "recommend_reject":
      return {
        label: "Toño sugiere rechazar",
        className: "bg-rose-100 text-rose-800 border-rose-300",
      };
    case "recommend_call":
      return {
        label: "Toño sugiere llamar",
        className: "bg-amber-100 text-amber-800 border-amber-300",
      };
  }
}

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleString("es-CO");
}

// Deterministic sort key per §3.5 #4. Lower tuple = higher in queue.
function sortKey(args: {
  candidate_state: CandidateState;
  onboarded_at: string;
  rec: TonoRecommendation | null;
  conf: number;
}): [number, number, number] {
  const { candidate_state, onboarded_at, rec, conf } = args;
  const ts = new Date(onboarded_at).getTime();
  // Bucket 0: needs_call STATE rows — HR scheduled a call; act on it.
  if (candidate_state === "needs_call") return [0, ts, 0];
  // Bucket 1: pending + recommend_call — FIFO (oldest first) so workers don't
  // sit forgotten in the call queue. Confidence ignored per §3.5.
  if (rec === "recommend_call") return [1, ts, 0];
  // Bucket 2: pending + recommend_approve — confidence DESC (high-conf at top).
  if (rec === "recommend_approve") return [2, -conf, 0];
  // Bucket 3: pending + recommend_reject — confidence DESC (high-conf at the
  // bottom of the queue; HR can batch through).
  if (rec === "recommend_reject") return [3, -conf, 0];
  // Bucket 4: pending without dossier (shouldn't happen — agent always submits).
  return [4, ts, 0];
}

export default async function HrQualificationQueuePage() {
  const auth = serverClientBoundToCookies();
  const { data: userData } = await auth.auth.getUser();
  if (!userData.user) redirect("/login");

  const supa = serviceClient();

  const { data: tecnicos } = await supa
    .from("tecnicos_extended")
    .select("*")
    .in("candidate_state", ["pending", "needs_call"])
    .limit(100);

  const ids = (tecnicos ?? []).map((t) => t.tecnico_id);

  // TODO(scale): two-query stitch is O(N+latest-dossier-per-N). Pilot scale
  // (~50 candidates) is fine; revisit with a Postgres view or RPC at >5k.
  const [regEventsRes, dossiersRes, notesRes] = ids.length
    ? await Promise.all([
        supa
          .from("eventos")
          .select("entity_id, meta, created_at")
          .eq("type", "tecnico_registered")
          .in("entity_id", ids)
          .order("created_at", { ascending: false }),
        supa
          .from("candidate_dossiers")
          .select("*")
          .in("tecnico_id", ids)
          .order("created_at", { ascending: false }),
        supa
          .from("hr_notes")
          .select("*")
          .in("tecnico_id", ids)
          .order("created_at", { ascending: false }),
      ])
    : [{ data: [] }, { data: [] }, { data: [] }];

  const regByTec = new Map<string, RegisteredMeta>();
  for (const e of regEventsRes.data ?? []) {
    if (!e.entity_id || regByTec.has(e.entity_id)) continue;
    regByTec.set(e.entity_id, parseRegisteredMeta(e.meta));
  }

  // Latest dossier per tecnico_id.
  const latestDossierByTec = new Map<string, DossierSummary>();
  for (const d of dossiersRes.data ?? []) {
    if (latestDossierByTec.has(d.tecnico_id)) continue;
    const sum = summarizeDossierPayload(d.payload);
    latestDossierByTec.set(d.tecnico_id, {
      id: d.id,
      tono_recommendation: d.tono_recommendation as TonoRecommendation,
      tono_confidence: Number(d.tono_confidence),
      tono_reasoning: d.tono_reasoning,
      cedula: d.cedula,
      ciudad_base: sum.ciudad_base,
      categorias: sum.categorias,
      subcategorias: sum.subcategorias,
      gaps: sum.gaps,
      created_at: d.created_at,
    });
  }

  // hr_notes grouped by tecnico_id (already reverse-chronological).
  const notesByTec = new Map<string, typeof notesRes.data>();
  for (const n of notesRes.data ?? []) {
    const arr = notesByTec.get(n.tecnico_id) ?? [];
    arr.push(n);
    notesByTec.set(n.tecnico_id, arr);
  }

  // Sort per §3.5 #4.
  const sorted = [...(tecnicos ?? [])].sort((a, b) => {
    const da = latestDossierByTec.get(a.tecnico_id);
    const db_ = latestDossierByTec.get(b.tecnico_id);
    const ka = sortKey({
      candidate_state: a.candidate_state,
      onboarded_at: a.onboarded_at,
      rec: da?.tono_recommendation ?? null,
      conf: da?.tono_confidence ?? 0,
    });
    const kb = sortKey({
      candidate_state: b.candidate_state,
      onboarded_at: b.onboarded_at,
      rec: db_?.tono_recommendation ?? null,
      conf: db_?.tono_confidence ?? 0,
    });
    if (ka[0] !== kb[0]) return ka[0] - kb[0];
    if (ka[1] !== kb[1]) return ka[1] - kb[1];
    return ka[2] - kb[2];
  });

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
        Técnicos esperando aprobación. Toño deja una recomendación; HR decide.
        El badge muestra qué sugiere y con qué confianza; clic en{" "}
        <em>¿por qué?</em> para leer el razonamiento completo.
      </p>

      {sorted.length === 0 ? (
        <div className="card p-4 text-sm text-slate-500">
          No hay técnicos en revisión. Vuelve cuando alguien nuevo se registre.
        </div>
      ) : (
        <ul className="space-y-3">
          {sorted.map((tec) => {
            const reg = regByTec.get(tec.tecnico_id);
            const dossier = latestDossierByTec.get(tec.tecnico_id);
            const notes = notesByTec.get(tec.tecnico_id) ?? [];
            const badge = dossier ? recommendationBadge(dossier.tono_recommendation) : null;

            return (
              <li key={tec.tecnico_id} className="card p-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    {/* Header */}
                    <div className="flex items-center gap-2 flex-wrap">
                      <Link
                        href={`/hr/tecnicos/${encodeURIComponent(tec.tecnico_id)}`}
                        className="font-medium text-slate-900 hover:text-amber-700"
                      >
                        {reg?.nombre ?? "(sin nombre)"}
                      </Link>
                      <span className="text-slate-500 font-normal">
                        · {dossier?.ciudad_base ?? reg?.ciudad ?? "—"}
                      </span>
                      {tec.candidate_state === "needs_call" && (
                        <span className="text-xs bg-violet-100 text-violet-800 rounded-full px-2 py-0.5">
                          📞 cita pendiente
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-slate-500 mt-0.5">
                      {tec.phone}
                      {dossier && <> · cédula {dossier.cedula}</>} · onboarded{" "}
                      {fmtTime(tec.onboarded_at)}
                    </div>

                    {/* Recommendation badge + raw confidence + why-expand */}
                    {dossier && badge && (
                      <div className="mt-3 space-y-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span
                            className={`text-xs rounded-full px-2 py-0.5 border ${badge.className}`}
                          >
                            {badge.label}
                          </span>
                          <span className="text-xs text-slate-600 tabular-nums">
                            ({dossier.tono_confidence.toFixed(2)})
                          </span>
                          <details className="text-xs">
                            <summary className="cursor-pointer text-slate-600 hover:text-slate-900">
                              ¿por qué?
                            </summary>
                            <div className="mt-1 text-slate-700 whitespace-pre-wrap border-l-2 border-slate-200 pl-2">
                              {dossier.tono_reasoning}
                              {dossier.gaps.length > 0 && (
                                <div className="mt-2">
                                  <div className="text-slate-500 uppercase tracking-wide text-[10px] mb-0.5">
                                    Vacíos detectados
                                  </div>
                                  <ul className="list-disc list-inside text-slate-600">
                                    {dossier.gaps.map((g, i) => (
                                      <li key={i}>{g}</li>
                                    ))}
                                  </ul>
                                </div>
                              )}
                            </div>
                          </details>
                        </div>
                      </div>
                    )}

                    {/* Categorías + subcategorías */}
                    {dossier && (dossier.categorias.length > 0 || dossier.subcategorias.length > 0) && (
                      <div className="text-sm text-slate-700 mt-2">
                        {dossier.categorias.length > 0 && (
                          <div>
                            <span className="text-slate-500">Categorías: </span>
                            {dossier.categorias.join(", ")}
                          </div>
                        )}
                        {dossier.subcategorias.length > 0 && (
                          <div className="text-xs text-slate-500 mt-0.5">
                            {dossier.subcategorias.join(" · ")}
                          </div>
                        )}
                      </div>
                    )}

                    {/* HR notes thread */}
                    {notes.length > 0 && (
                      <div className="mt-3 space-y-1">
                        <div className="text-[10px] uppercase tracking-wide text-slate-500">
                          Notas HR ({notes.length})
                        </div>
                        <ul className="space-y-1">
                          {notes.map((n) => (
                            <li
                              key={n.id}
                              className="text-xs text-slate-700 bg-slate-50 rounded px-2 py-1"
                            >
                              <div className="text-[10px] text-slate-500">
                                {n.hr_user} · {fmtTime(n.created_at)}
                              </div>
                              <div className="whitespace-pre-wrap">{n.body}</div>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {/* Add note form */}
                    <form action={appendHrNote} className="mt-3 flex gap-2">
                      <input type="hidden" name="tecnico_id" value={tec.tecnico_id} />
                      <input
                        type="text"
                        name="body"
                        placeholder="Agregar nota..."
                        className="flex-1 text-xs border border-slate-200 rounded px-2 py-1"
                        maxLength={2000}
                        required
                      />
                      <button
                        type="submit"
                        className="text-xs bg-slate-100 hover:bg-slate-200 text-slate-700 rounded px-2 py-1"
                      >
                        Agregar
                      </button>
                    </form>
                  </div>

                  {/* Decision actions + hr_reasoning. Single form with multi-button:
                      the clicked button's name/value (decision) is what's posted.
                      VERIFY GATE (per Stream B plan): before promoting commit 2 to
                      prod, click each button against a real seed candidate in dev
                      and verify candidate_decisions.decision matches each click.
                      If FormData drops the clicked button's value, switch to
                      per-button formAction. */}
                  <form action={submitDecision} className="flex flex-col gap-2 shrink-0 w-44">
                    <input type="hidden" name="tecnico_id" value={tec.tecnico_id} />
                    <input type="hidden" name="prior_state" value={tec.candidate_state} />
                    <input type="hidden" name="dossier_id" value={dossier?.id ?? ""} />
                    <textarea
                      name="hr_reasoning"
                      placeholder="¿Por qué? (opcional)"
                      className="text-xs border border-slate-200 rounded px-2 py-1 resize-none"
                      rows={2}
                    />
                    <button
                      type="submit"
                      name="decision"
                      value="approve"
                      className="w-full text-xs bg-emerald-600 hover:bg-emerald-700 text-white rounded-md px-3 py-1"
                    >
                      Aprobar
                    </button>
                    {tec.candidate_state === "pending" && (
                      <button
                        type="submit"
                        name="decision"
                        value="schedule_call"
                        className="w-full text-xs bg-amber-500 hover:bg-amber-600 text-white rounded-md px-3 py-1"
                      >
                        Pedir llamada
                      </button>
                    )}
                    {tec.candidate_state === "needs_call" && (
                      <button
                        type="submit"
                        name="decision"
                        value="unschedule_call"
                        className="w-full text-xs bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-md px-3 py-1"
                      >
                        Quitar llamada
                      </button>
                    )}
                    <button
                      type="submit"
                      name="decision"
                      value="reject"
                      className="w-full text-xs border border-slate-300 hover:bg-slate-50 text-slate-700 rounded-md px-3 py-1"
                    >
                      Rechazar
                    </button>
                  </form>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
