// Per-worker detail page — everything HR needs to know about one técnico:
// profile, Toño's qualification summary, outbound WhatsApp messages, postulaciones,
// contratos, and the raw eventos log. Read-only by design; decision actions stay
// on /hr/qualification-queue and /hr/pipeline so each surface keeps a single job.

import { serverClientBoundToCookies, serviceClient } from "@/lib/supabase-server";
import type { QualificationState } from "@redin/shared";
import { redirect } from "next/navigation";
import Link from "next/link";

export const dynamic = "force-dynamic";

const STATE_CLASS: Record<QualificationState, string> = {
  pending: "bg-amber-100 text-amber-800",
  needs_review: "bg-emerald-100 text-emerald-800",
  needs_call: "bg-blue-100 text-blue-800",
  qualified: "bg-slate-900 text-white",
  rejected: "bg-rose-100 text-rose-800",
};

function fmt(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("es-CO");
}

interface RegisteredMeta {
  nombre?: string;
  ciudad?: string;
  especialidades?: string[];
  modalidad?: string;
}
function parseRegistered(meta: unknown): RegisteredMeta {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return {};
  const m = meta as Record<string, unknown>;
  return {
    nombre: typeof m.nombre === "string" ? m.nombre : undefined,
    ciudad: typeof m.ciudad === "string" ? m.ciudad : undefined,
    especialidades: Array.isArray(m.especialidades)
      ? m.especialidades.filter((x): x is string => typeof x === "string")
      : undefined,
    modalidad: typeof m.modalidad === "string" ? m.modalidad : undefined,
  };
}

interface ReviewMeta {
  summary?: string;
}
function parseReview(meta: unknown): ReviewMeta {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return {};
  const m = meta as Record<string, unknown>;
  return { summary: typeof m.summary === "string" ? m.summary : undefined };
}

export default async function TecnicoDetailPage({
  params,
}: {
  params: { id: string };
}) {
  const auth = serverClientBoundToCookies();
  const { data: userData } = await auth.auth.getUser();
  if (!userData.user) redirect("/login");

  const supa = serviceClient();
  const tecnicoId = decodeURIComponent(params.id);

  const { data: tec } = await supa
    .from("tecnicos_extended")
    .select("*")
    .eq("tecnico_id", tecnicoId)
    .maybeSingle();
  if (!tec) {
    return (
      <div className="card p-6">
        <Link href="/hr/tecnicos" className="text-sm text-slate-500 hover:text-slate-700">
          ← Técnicos
        </Link>
        <h1 className="mt-3 text-lg font-semibold text-slate-900">
          Técnico no encontrado
        </h1>
      </div>
    );
  }

  // Latest registration meta (nombre/ciudad/especialidades/modalidad)
  const { data: regEvent } = await supa
    .from("eventos")
    .select("meta")
    .eq("type", "tecnico_registered")
    .eq("entity_id", tecnicoId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const reg = parseRegistered(regEvent?.meta);

  // Latest qualification_review_requested meta (Toño's summary)
  const { data: reviewEvent } = await supa
    .from("eventos")
    .select("meta, created_at")
    .eq("type", "qualification_review_requested")
    .eq("entity_id", tecnicoId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const review = parseReview(reviewEvent?.meta);

  // Outbound messages — most recent first
  const { data: outbound } = await supa
    .from("outbound_messages")
    .select("*")
    .eq("phone", tec.phone)
    .order("created_at", { ascending: false })
    .limit(50);

  // Postulaciones with their OT
  const { data: postulaciones } = await supa
    .from("postulaciones")
    .select("*")
    .eq("tecnico_id", tecnicoId)
    .order("applied_at", { ascending: false });
  const otIds = [...new Set((postulaciones ?? []).map((p) => p.ot_id))];
  const { data: ots } = otIds.length
    ? await supa
        .from("ots_mirror")
        .select("row_id, ciudad, especialidad, estado")
        .in("row_id", otIds)
    : { data: [] };
  const otByRowId = new Map(
    (ots ?? []).map((o) => [
      o.row_id,
      `${o.ciudad ?? "—"} · ${o.especialidad ?? "—"} · ${o.estado ?? "—"}`,
    ])
  );

  // Contratos
  const { data: contratos } = await supa
    .from("contratos")
    .select("*")
    .eq("tecnico_id", tecnicoId)
    .order("sent_at", { ascending: false, nullsFirst: false });

  // Evaluations
  const { data: evaluations } = await supa
    .from("tecnico_evaluations")
    .select("*")
    .eq("tecnico_id", tecnicoId)
    .order("created_at", { ascending: false });

  // Full event log (raw bitácora)
  const { data: events } = await supa
    .from("eventos")
    .select("type, actor, meta, created_at")
    .eq("entity_id", tecnicoId)
    .order("created_at", { ascending: false })
    .limit(100);

  const stateClass = STATE_CLASS[tec.qualification_state] ?? "bg-slate-100 text-slate-700";

  return (
    <div className="space-y-6">
      <Link href="/hr/tecnicos" className="text-sm text-slate-500 hover:text-slate-700">
        ← Técnicos
      </Link>

      {/* Profile header */}
      <div className="card p-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold text-slate-900">
              {reg.nombre ?? "(sin nombre)"}
            </h1>
            <div className="text-sm text-slate-500 mt-1">
              {tec.phone} · {reg.ciudad ?? "—"} · onboarded {fmt(tec.onboarded_at)}
            </div>
            {reg.especialidades && reg.especialidades.length > 0 && (
              <div className="text-sm text-slate-700 mt-2">
                <span className="text-slate-500">Especialidades: </span>
                {reg.especialidades.join(", ")}
                {reg.modalidad && (
                  <span className="text-slate-500"> · {reg.modalidad}</span>
                )}
              </div>
            )}
          </div>
          <span className={`inline-block rounded-full px-3 py-1 text-sm ${stateClass}`}>
            {tec.qualification_state}
          </span>
        </div>
      </div>

      {/* Toño's qualification summary */}
      {review.summary && (
        <div className="card p-4 border-l-4 border-amber-300">
          <div className="text-xs uppercase tracking-wide text-slate-500 mb-1">
            Resumen de Toño · {fmt(reviewEvent?.created_at)}
          </div>
          <div className="text-sm text-slate-800">{review.summary}</div>
        </div>
      )}

      {/* Outbound WhatsApp messages */}
      <div className="space-y-2">
        <h2 className="font-semibold text-slate-900">Mensajes enviados ({(outbound ?? []).length})</h2>
        {(outbound ?? []).length === 0 ? (
          <div className="card p-3 text-sm text-slate-500">
            Aún no se han enviado mensajes a este número.
          </div>
        ) : (
          <ul className="space-y-2">
            {(outbound ?? []).map((m) => {
              const statusClass =
                m.status === "sent"
                  ? "text-emerald-700"
                  : m.status === "failed"
                  ? "text-rose-700"
                  : "text-amber-700";
              return (
                <li key={m.id} className="card p-3">
                  <div className="flex items-center justify-between text-xs text-slate-500">
                    <span>
                      <span className={statusClass + " font-medium"}>{m.status}</span>
                      {m.sent_at && <span> · enviado {fmt(m.sent_at)}</span>}
                      {m.status === "pending" && <span> · creado {fmt(m.created_at)}</span>}
                      {m.attempts > 0 && <span> · intentos {m.attempts}</span>}
                    </span>
                    <span>{m.channel}</span>
                  </div>
                  <div className="text-sm text-slate-800 mt-1 whitespace-pre-wrap">
                    {m.body}
                  </div>
                  {m.last_error && (
                    <div className="text-xs text-rose-700 mt-1">
                      error: {m.last_error}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* Postulaciones */}
      <div className="space-y-2">
        <h2 className="font-semibold text-slate-900">Postulaciones ({(postulaciones ?? []).length})</h2>
        {(postulaciones ?? []).length === 0 ? (
          <div className="card p-3 text-sm text-slate-500">Sin postulaciones aún.</div>
        ) : (
          <ul className="space-y-1">
            {(postulaciones ?? []).map((p) => (
              <li
                key={p.id}
                className="card p-3 text-sm flex items-center justify-between"
              >
                <div>
                  <Link
                    href={`/hr/shortlist/${encodeURIComponent(p.ot_id)}`}
                    className="text-slate-900 hover:text-amber-700 font-medium"
                  >
                    OT {p.ot_id.slice(0, 12)}
                  </Link>
                  <span className="text-slate-500 ml-2">
                    {otByRowId.get(p.ot_id) ?? "—"}
                  </span>
                </div>
                <div className="text-xs text-slate-500">
                  <span className="text-slate-700">{p.state}</span> · aplicó{" "}
                  {fmt(p.applied_at)}
                  {p.decided_at && (
                    <>
                      {" · decisión "}
                      {fmt(p.decided_at)}
                    </>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Contratos */}
      <div className="space-y-2">
        <h2 className="font-semibold text-slate-900">Contratos ({(contratos ?? []).length})</h2>
        {(contratos ?? []).length === 0 ? (
          <div className="card p-3 text-sm text-slate-500">Sin contratos aún.</div>
        ) : (
          <ul className="space-y-1">
            {(contratos ?? []).map((c) => (
              <li
                key={c.id}
                className="card p-3 text-sm flex items-center justify-between"
              >
                <Link
                  href={`/hr/contratos/${c.id}`}
                  className="text-slate-900 hover:text-amber-700 font-medium"
                >
                  Contrato {c.id.slice(0, 8)}
                </Link>
                <div className="text-xs text-slate-500">
                  <span className="text-slate-700">{c.status}</span>
                  {c.sent_at && <> · enviado {fmt(c.sent_at)}</>}
                  {c.signed_at && <> · firmado {fmt(c.signed_at)}</>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Evaluaciones */}
      {(evaluations ?? []).length > 0 && (
        <div className="space-y-2">
          <h2 className="font-semibold text-slate-900">
            Evaluaciones ({evaluations!.length})
          </h2>
          <ul className="space-y-1">
            {evaluations!.map((e) => (
              <li key={e.id} className="card p-3 text-sm">
                <div className="text-xs text-slate-500">
                  OT {e.ot_id.slice(0, 12)} · evaluador {e.evaluator} · {fmt(e.created_at)}
                </div>
                <div className="text-slate-700 mt-1">
                  cumplimiento {e.cumplimiento ?? "—"} · calidad {e.calidad ?? "—"} ·{" "}
                  actitud {e.actitud ?? "—"} · puntualidad {e.puntualidad ?? "—"} ·{" "}
                  rehire{" "}
                  {e.recommend_rehire === true
                    ? "sí"
                    : e.recommend_rehire === false
                    ? "no"
                    : "—"}
                </div>
                {e.notes && (
                  <div className="text-slate-600 mt-1 text-xs">{e.notes}</div>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Raw event log */}
      <details className="card p-3">
        <summary className="cursor-pointer font-semibold text-slate-900">
          Bitácora ({(events ?? []).length})
        </summary>
        <ul className="mt-2 space-y-1 text-xs">
          {(events ?? []).map((e, i) => (
            <li key={i} className="border-t border-slate-100 pt-1">
              <div className="flex justify-between">
                <span className="font-medium text-slate-700">{e.type}</span>
                <span className="text-slate-500">{fmt(e.created_at)}</span>
              </div>
              {e.actor && <div className="text-slate-500">actor: {e.actor}</div>}
              {e.meta && (
                <pre className="text-[11px] text-slate-600 whitespace-pre-wrap break-all">
                  {JSON.stringify(e.meta, null, 2)}
                </pre>
              )}
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}
