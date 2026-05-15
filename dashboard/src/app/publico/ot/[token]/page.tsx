// Public architect-facing view for one OT. No login required — gated by an
// HMAC-signed token in the URL (see lib/public-token.ts). Architects open
// this from a link HR shares; they see who postulated for the OT but no
// contact details — those live in AppSheet's TECNICOS table, which is
// already enriched via the reverse-projection.

import { serviceClient } from "@/lib/supabase-server";
import { verifyOtPublicToken } from "@/lib/public-token";
import { otTitle, tecnicoLabel } from "@/lib/ot-display";
import { rankPostulaciones } from "@/lib/ranking";
import { notFound } from "next/navigation";
import type { PostulacionRow, TonoRecommendation } from "@redin/shared";

export const dynamic = "force-dynamic";

interface Props {
  params: { token: string };
}

interface ApplicantView {
  postulacion_id: string;
  tecnico_id: string;
  display_name: string;
  ciudad: string | null;
  modalidad: string | null;
  anos_experiencia: number | null;
  categorias: string[];
  subcategorias: string[];
  state: string;
  applied_at_human: string;
  tono_recommendation: TonoRecommendation | null;
  tono_confidence: number | null;
  rating_avg: number | null;
  rating_count: number;
  contratos_firmados: number;
  scores: { disponibilidad: number; calidad: number | null };
}

function parseRegistered(meta: unknown): {
  ciudad: string | null;
  modalidad: string | null;
} {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
    return { ciudad: null, modalidad: null };
  }
  const m = meta as Record<string, unknown>;
  return {
    ciudad: typeof m.ciudad === "string" ? m.ciudad : null,
    modalidad: typeof m.modalidad === "string" ? m.modalidad : null,
  };
}

function parseDossierPayload(payload: unknown): {
  anos_experiencia: number | null;
  categorias: string[];
  subcategorias: string[];
} {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { anos_experiencia: null, categorias: [], subcategorias: [] };
  }
  const p = payload as Record<string, unknown>;
  const anos = typeof p.anos_experiencia === "number" ? p.anos_experiencia : null;
  const cats = Array.isArray(p.categorias_principales)
    ? (p.categorias_principales as unknown[]).filter((x): x is string => typeof x === "string")
    : [];
  const subs = Array.isArray(p.subcategorias)
    ? (p.subcategorias as unknown[]).filter((x): x is string => typeof x === "string")
    : [];
  return { anos_experiencia: anos, categorias: cats, subcategorias: subs };
}

function fmtRelative(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.floor(ms / 60000);
  if (min < 60) return `hace ${min} min`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `hace ${hr} ${hr === 1 ? "hora" : "horas"}`;
  const d = Math.floor(hr / 24);
  return `hace ${d} ${d === 1 ? "día" : "días"}`;
}

function recommendationChip(rec: TonoRecommendation | null): {
  label: string;
  className: string;
} | null {
  if (!rec) return null;
  switch (rec) {
    case "recommend_approve":
      return { label: "Toño recomienda", className: "bg-emerald-100 text-emerald-800" };
    case "recommend_reject":
      return { label: "Toño no recomienda", className: "bg-rose-100 text-rose-800" };
    case "recommend_call":
      return { label: "Toño sugiere llamar", className: "bg-amber-100 text-amber-800" };
  }
}

function postulacionStateChip(state: string): { label: string; className: string } {
  switch (state) {
    case "preseleccionado":
      return { label: "Preseleccionado por HR", className: "bg-emerald-100 text-emerald-800" };
    case "asignado":
      return { label: "Asignado", className: "bg-slate-900 text-white" };
    case "rechazado":
      return { label: "Rechazado", className: "bg-rose-100 text-rose-800" };
    case "postulado":
    default:
      return { label: "Postulado", className: "bg-slate-100 text-slate-700" };
  }
}

export default async function PublicOtPage({ params }: Props) {
  const otId = verifyOtPublicToken(params.token);
  if (!otId) notFound();

  const supa = serviceClient();
  const { data: ot } = await supa
    .from("ots_mirror")
    .select("row_id, ciudad, especialidad, estado, data")
    .eq("row_id", otId)
    .maybeSingle();
  if (!ot) notFound();

  const { data: posts } = await supa
    .from("postulaciones")
    .select("*")
    .eq("ot_id", otId)
    .order("applied_at", { ascending: false });
  const postulaciones: PostulacionRow[] = posts ?? [];
  const tecnicoIds = [...new Set(postulaciones.map((p) => p.tecnico_id))];

  // Hydrate the per-applicant view objects in parallel.
  const [tecRes, regRes, dossiersRes, perfRes, contratosRes, openPosRes] =
    tecnicoIds.length
      ? await Promise.all([
          supa
            .from("tecnicos_extended")
            .select("tecnico_id, nombre")
            .in("tecnico_id", tecnicoIds),
          supa
            .from("eventos")
            .select("entity_id, meta, created_at")
            .eq("type", "tecnico_registered")
            .in("entity_id", tecnicoIds)
            .order("created_at", { ascending: false }),
          supa
            .from("candidate_dossiers")
            .select("tecnico_id, payload, tono_recommendation, tono_confidence, created_at")
            .in("tecnico_id", tecnicoIds)
            .order("created_at", { ascending: false }),
          supa
            .from("tecnico_performance")
            .select("tecnico_id, avg_score, eval_count")
            .in("tecnico_id", tecnicoIds),
          supa
            .from("contratos")
            .select("tecnico_id, status")
            .in("tecnico_id", tecnicoIds)
            .eq("status", "firmado"),
          supa
            .from("postulaciones")
            .select("tecnico_id, state")
            .in("tecnico_id", tecnicoIds)
            .in("state", ["postulado", "preseleccionado"]),
        ])
      : [
          { data: [] },
          { data: [] },
          { data: [] },
          { data: [] },
          { data: [] },
          { data: [] },
        ];

  const nombreByTec = new Map<string, string | null>();
  for (const t of tecRes.data ?? []) nombreByTec.set(t.tecnico_id, t.nombre ?? null);

  const regByTec = new Map<string, ReturnType<typeof parseRegistered>>();
  for (const e of regRes.data ?? []) {
    if (!e.entity_id || regByTec.has(e.entity_id)) continue;
    regByTec.set(e.entity_id, parseRegistered(e.meta));
  }

  const dossierByTec = new Map<
    string,
    { rec: TonoRecommendation | null; conf: number | null; payload: unknown }
  >();
  for (const d of dossiersRes.data ?? []) {
    if (dossierByTec.has(d.tecnico_id)) continue;
    dossierByTec.set(d.tecnico_id, {
      rec: d.tono_recommendation as TonoRecommendation,
      conf: Number(d.tono_confidence),
      payload: d.payload,
    });
  }

  const perfByTec = new Map<string, { avg: number | null; count: number }>();
  for (const p of perfRes.data ?? []) {
    perfByTec.set(p.tecnico_id, {
      avg: p.eval_count > 0 && p.avg_score !== null ? Number(p.avg_score) : null,
      count: p.eval_count ?? 0,
    });
  }

  const firmadoByTec = new Map<string, number>();
  for (const c of contratosRes.data ?? []) {
    firmadoByTec.set(c.tecnico_id, (firmadoByTec.get(c.tecnico_id) ?? 0) + 1);
  }

  const openPosByTec = new Map<string, number>();
  for (const p of openPosRes.data ?? []) {
    openPosByTec.set(p.tecnico_id, (openPosByTec.get(p.tecnico_id) ?? 0) + 1);
  }

  const ratingByTec = new Map<string, number | null>();
  for (const id of tecnicoIds) {
    ratingByTec.set(id, perfByTec.get(id)?.avg ?? null);
  }

  // Reuse the same ranker HR sees so architects view candidates in the same
  // order — no surprises when they coordinate with HR.
  const ranked = rankPostulaciones({
    postulaciones,
    openPosByTecnico: openPosByTec,
    ratingByTecnico: ratingByTec,
  });

  const applicants: ApplicantView[] = ranked.map((r) => {
    const reg = regByTec.get(r.postulacion.tecnico_id) ?? { ciudad: null, modalidad: null };
    const dossier = dossierByTec.get(r.postulacion.tecnico_id);
    const dParsed = dossier ? parseDossierPayload(dossier.payload) : {
      anos_experiencia: null,
      categorias: [],
      subcategorias: [],
    };
    const perf = perfByTec.get(r.postulacion.tecnico_id);
    return {
      postulacion_id: r.postulacion.id,
      tecnico_id: r.postulacion.tecnico_id,
      display_name: tecnicoLabel({
        nombre: nombreByTec.get(r.postulacion.tecnico_id) ?? null,
        ciudad: null,
      }),
      ciudad: reg.ciudad,
      modalidad: reg.modalidad,
      anos_experiencia: dParsed.anos_experiencia,
      categorias: dParsed.categorias,
      subcategorias: dParsed.subcategorias,
      state: r.postulacion.state,
      applied_at_human: fmtRelative(r.postulacion.applied_at),
      tono_recommendation: dossier?.rec ?? null,
      tono_confidence: dossier?.conf ?? null,
      rating_avg: perf?.avg ?? null,
      rating_count: perf?.count ?? 0,
      contratos_firmados: firmadoByTec.get(r.postulacion.tecnico_id) ?? 0,
      scores: r.scores,
    };
  });

  const otHeadline = otTitle(ot);
  const isOfferable = ot.estado === "4. Coordinar – Listo para ejecutar";

  return (
    <div className="min-h-screen bg-slate-50">
      <div className="max-w-3xl mx-auto px-4 py-8 space-y-6">
        <div className="text-xs uppercase tracking-wide text-slate-500">
          Vista para arquitectos · Redin
        </div>
        <div className="bg-white rounded-lg border border-slate-200 p-5">
          <div className="text-sm text-slate-500">
            {ot.ciudad ?? "—"} · {ot.especialidad ?? "—"}
          </div>
          <h1 className="text-xl font-semibold text-slate-900 mt-0.5">
            {otHeadline}
          </h1>
          <div className="text-sm text-slate-700 mt-2">
            Estado: <strong>{ot.estado ?? "—"}</strong>
            {!isOfferable && (
              <span className="ml-2 text-xs text-amber-700">
                (esta OT ya no está en estado de coordinación)
              </span>
            )}
          </div>
          <div className="text-[11px] text-slate-400 font-mono mt-1">
            {ot.row_id.slice(0, 8)}
          </div>
          <div className="text-sm text-slate-600 mt-3">
            <strong>{applicants.length}</strong>{" "}
            {applicants.length === 1 ? "técnico postulado" : "técnicos postulados"}.
            Para asignar a una actividad, busca el nombre en la tabla TECNICOS de
            AppSheet — los datos de contacto y evaluaciones están allí.
          </div>
        </div>

        {applicants.length === 0 ? (
          <div className="bg-white rounded-lg border border-slate-200 p-5 text-sm text-slate-500">
            Nadie se ha postulado todavía. Toño está ofreciendo este trabajo a
            los técnicos disponibles; vuelve a refrescar más tarde.
          </div>
        ) : (
          <ul className="space-y-3">
            {applicants.map((a) => {
              const recChip = recommendationChip(a.tono_recommendation);
              const stateChip = postulacionStateChip(a.state);
              return (
                <li
                  key={a.postulacion_id}
                  className="bg-white rounded-lg border border-slate-200 p-4"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="font-semibold text-slate-900">
                        {a.display_name}
                        {a.ciudad && (
                          <span className="font-normal text-slate-500">
                            {" "}· {a.ciudad}
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-slate-500 mt-0.5">
                        {a.modalidad && <span>{a.modalidad}</span>}
                        {a.anos_experiencia !== null && (
                          <>
                            {a.modalidad && " · "}
                            {a.anos_experiencia} años
                          </>
                        )}
                      </div>
                    </div>
                    <span
                      className={`text-xs rounded-full px-2 py-0.5 shrink-0 ${stateChip.className}`}
                    >
                      {stateChip.label}
                    </span>
                  </div>

                  {(a.categorias.length > 0 || a.subcategorias.length > 0) && (
                    <div className="text-sm text-slate-700 mt-2">
                      {a.categorias.length > 0 && (
                        <div>{a.categorias.join(" · ")}</div>
                      )}
                      {a.subcategorias.length > 0 && (
                        <div className="text-xs text-slate-500 mt-0.5">
                          {a.subcategorias.join(" · ")}
                        </div>
                      )}
                    </div>
                  )}

                  <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-slate-600">
                    <span>
                      ⭐{" "}
                      {a.rating_avg !== null
                        ? `${a.rating_avg.toFixed(1)} (${a.rating_count} evaluaciones)`
                        : "Sin evaluaciones aún"}
                    </span>
                    <span>·</span>
                    <span>
                      {a.contratos_firmados} contratos firmados
                    </span>
                    <span>·</span>
                    <span>Aplicó {a.applied_at_human}</span>
                  </div>

                  <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                    {recChip && (
                      <span
                        className={`rounded-full px-2 py-0.5 ${recChip.className}`}
                      >
                        {recChip.label}
                        {a.tono_confidence !== null && (
                          <span className="ml-1 tabular-nums">
                            ({a.tono_confidence.toFixed(2)})
                          </span>
                        )}
                      </span>
                    )}
                    <span className="text-slate-500 tabular-nums">
                      dispo {a.scores.disponibilidad.toFixed(2)}
                    </span>
                    {a.scores.calidad !== null && (
                      <span className="text-slate-500 tabular-nums">
                        · calidad {a.scores.calidad.toFixed(1)}
                      </span>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        <div className="text-xs text-slate-400 text-center pt-4">
          Para preseleccionar y enviar un contrato, coordina con el equipo de
          recursos humanos de Redin.
        </div>
      </div>
    </div>
  );
}
