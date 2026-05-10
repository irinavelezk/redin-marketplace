// HR pipeline — OTs in state "4. Coordinar – Listo para ejecutar" with a
// per-OT status pill that tells HR what action is owed:
//
//   Esperando decisión        — postulados exist, no preselección yet
//   Listo para contrato       — preseleccionados, contract not sent
//   Contrato enviado          — sent, awaiting signature
//   Asignado en Redin         — contract signed; waiting on architect to
//                               confirm the assignment in AppSheet
//   Sin postulaciones         — open OT, nobody applied
//
// Sort: needs-HR-action first; passive states sink. Each card carries a
// "Compartir con arquitecto" button that copies a signed public link
// (lib/public-token) for the architect-facing slim view.
//
// The internal candidate ranking (disponibilidad → calidad → costo) is
// preserved per OT — calidad will become the primary signal for the future
// autonomous-assignment agent, so HR getting accustomed to it now matters.

import { serverClientBoundToCookies, serviceClient } from "@/lib/supabase-server";
import { rankPostulaciones } from "@/lib/ranking";
import { otTitle, tecnicoLabel } from "@/lib/ot-display";
import { signOtPublicToken } from "@/lib/public-token";
import { OFFERABLE_ESTADO } from "@redin/tools/read-pending-ots";
import type { PostulacionRow, ContratoStatus } from "@redin/shared";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import Link from "next/link";
import { CopyShareLinkButton } from "@/components/CopyShareLinkButton";

export const dynamic = "force-dynamic";

type OtStatusKey =
  | "esperando_decision"
  | "listo_para_contrato"
  | "contrato_enviado"
  | "asignado_en_redin"
  | "sin_postulaciones";

interface OtStatus {
  key: OtStatusKey;
  label: string;
  className: string;
  sortIndex: number;
}

function computeOtStatus(args: {
  postCount: number;
  postStates: Set<string>;
  contractStates: Set<ContratoStatus>;
}): OtStatus {
  const { postCount, postStates, contractStates } = args;

  if (postCount === 0) {
    return {
      key: "sin_postulaciones",
      label: "Sin postulaciones",
      className: "bg-slate-100 text-slate-600",
      sortIndex: 4,
    };
  }
  if (postStates.has("asignado") || contractStates.has("firmado")) {
    return {
      key: "asignado_en_redin",
      label: "Asignado en Redin",
      className: "bg-slate-900 text-white",
      sortIndex: 5,
    };
  }
  if (contractStates.has("enviado")) {
    return {
      key: "contrato_enviado",
      label: "Contrato enviado",
      className: "bg-blue-100 text-blue-800",
      sortIndex: 3,
    };
  }
  if (postStates.has("preseleccionado")) {
    return {
      key: "listo_para_contrato",
      label: "Listo para contrato",
      className: "bg-emerald-100 text-emerald-800",
      sortIndex: 2,
    };
  }
  return {
    key: "esperando_decision",
    label: "Esperando decisión",
    className: "bg-amber-100 text-amber-800",
    sortIndex: 1,
  };
}

function publicOriginFromHeaders(): string {
  // NEXT_PUBLIC_SITE_URL is the canonical origin (Railway assigns it as an
  // env var); fall back to request headers when it's not set (e.g. local).
  const fromEnv = process.env.NEXT_PUBLIC_SITE_URL;
  if (fromEnv) return fromEnv.replace(/\/$/, "");
  const h = headers();
  const host = h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? "https";
  return `${proto}://${host}`;
}

export default async function HrPipelinePage() {
  const auth = serverClientBoundToCookies();
  const { data: userData } = await auth.auth.getUser();
  if (!userData.user) redirect("/login");

  const supa = serviceClient();
  const origin = publicOriginFromHeaders();

  // Pipeline shows ONLY assignable OTs — state "4. Coordinar – Listo para
  // ejecutar". The literal lives in @redin/tools/read-pending-ots so this
  // view, the read_pending_ots tool, and (eventually) the AppSheet sync
  // Selector all reference one source of truth.
  const { data: offerableOts } = await supa
    .from("ots_mirror")
    .select("row_id, ciudad, especialidad, estado, data, synced_at")
    .eq("estado", OFFERABLE_ESTADO)
    .order("synced_at", { ascending: false });
  const pendingOts = offerableOts ?? [];
  const offerableIds = pendingOts.map((o) => o.row_id);

  // Postulaciones AND contratos scoped to the offerable OTs only — both
  // feed the per-OT status pill computation and the ranking display.
  const [postsRes, contratosRes] = offerableIds.length
    ? await Promise.all([
        supa.from("postulaciones").select("*").in("ot_id", offerableIds),
        supa
          .from("contratos")
          .select("ot_id, status")
          .in("ot_id", offerableIds),
      ])
    : [
        { data: [] as PostulacionRow[] },
        { data: [] as { ot_id: string | null; status: ContratoStatus }[] },
      ];
  const allPostsForPending: PostulacionRow[] = postsRes.data ?? [];
  const contratoStatesByOt = new Map<string, Set<ContratoStatus>>();
  for (const c of contratosRes.data ?? []) {
    if (!c.ot_id) continue;
    const s = contratoStatesByOt.get(c.ot_id) ?? new Set<ContratoStatus>();
    s.add(c.status);
    contratoStatesByOt.set(c.ot_id, s);
  }

  // Internal performance (Jose + arquitectos via /hr/evaluations). calidad
  // is the seed for the future autonomous-assignment agent; we keep it
  // visible on the pipeline so HR is calibrated to the signal early.
  const tecnicoIds = [...new Set(allPostsForPending.map((p) => p.tecnico_id))];
  const { data: perfRows } = tecnicoIds.length
    ? await supa
        .from("tecnico_performance")
        .select("tecnico_id, avg_score, eval_count")
        .in("tecnico_id", tecnicoIds)
    : { data: [] };
  const ratingByTec = new Map<string, number | null>();
  for (const id of tecnicoIds) ratingByTec.set(id, null);
  for (const r of perfRows ?? []) {
    ratingByTec.set(
      r.tecnico_id,
      r.eval_count > 0 && r.avg_score !== null ? r.avg_score : null
    );
  }

  const { data: openPosRows } = tecnicoIds.length
    ? await supa
        .from("postulaciones")
        .select("tecnico_id,state")
        .in("tecnico_id", tecnicoIds)
        .in("state", ["postulado", "preseleccionado"])
    : { data: [] };
  const openPosByTec = new Map<string, number>();
  for (const r of openPosRows ?? []) {
    openPosByTec.set(r.tecnico_id, (openPosByTec.get(r.tecnico_id) ?? 0) + 1);
  }

  const { data: tecRows } = tecnicoIds.length
    ? await supa
        .from("tecnicos_extended")
        .select("tecnico_id, nombre")
        .in("tecnico_id", tecnicoIds)
    : { data: [] };
  const nombreByTec = new Map<string, string | null>();
  for (const r of tecRows ?? []) {
    nombreByTec.set(r.tecnico_id, r.nombre ?? null);
  }

  const { data: ciudadEvents } = tecnicoIds.length
    ? await supa
        .from("eventos")
        .select("entity_id, meta, created_at")
        .eq("type", "tecnico_registered")
        .in("entity_id", tecnicoIds)
        .order("created_at", { ascending: false })
    : { data: [] };
  const ciudadByTec = new Map<string, string | null>();
  for (const e of ciudadEvents ?? []) {
    if (!e.entity_id || ciudadByTec.has(e.entity_id)) continue;
    const meta = e.meta as Record<string, unknown> | null;
    const c = meta && typeof meta.ciudad === "string" ? meta.ciudad : null;
    ciudadByTec.set(e.entity_id, c);
  }

  const postsByOt = new Map<string, PostulacionRow[]>();
  for (const p of allPostsForPending) {
    if (!postsByOt.has(p.ot_id)) postsByOt.set(p.ot_id, []);
    postsByOt.get(p.ot_id)!.push(p);
  }

  // Pre-compute status + sort key for every OT so we can re-order before
  // rendering. Stable secondary sort by synced_at desc.
  interface OtRow {
    ot: (typeof pendingOts)[number];
    posts: PostulacionRow[];
    status: OtStatus;
  }
  const rows: OtRow[] = pendingOts.map((ot) => {
    const posts = postsByOt.get(ot.row_id) ?? [];
    const postStates = new Set(posts.map((p) => p.state));
    const contractStates = contratoStatesByOt.get(ot.row_id) ?? new Set();
    const status = computeOtStatus({
      postCount: posts.length,
      postStates,
      contractStates,
    });
    return { ot, posts, status };
  });
  rows.sort((a, b) => {
    if (a.status.sortIndex !== b.status.sortIndex) {
      return a.status.sortIndex - b.status.sortIndex;
    }
    // Tiebreak: most-recently-synced first, so freshness still matters.
    return (
      new Date(b.ot.synced_at ?? 0).getTime() -
      new Date(a.ot.synced_at ?? 0).getTime()
    );
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-slate-900">Pipeline HR</h1>
        <div className="flex items-center gap-3">
          <Link
            href="/hr/qualification-queue"
            className="text-sm text-amber-600 hover:text-amber-700 font-medium"
          >
            Cola de calificación →
          </Link>
          <Link
            href="/hr/tecnicos"
            className="text-sm text-slate-600 hover:text-slate-900"
          >
            Técnicos →
          </Link>
          <Link
            href="/hr/contratos"
            className="text-sm text-slate-600 hover:text-slate-900"
          >
            Contratos →
          </Link>
          <Link
            href="/hr/evaluations"
            className="text-sm text-slate-600 hover:text-slate-900"
          >
            Evaluaciones →
          </Link>
        </div>
      </div>
      <p className="text-sm text-slate-600">
        OTs en estado <strong>4. Coordinar – Listo para ejecutar</strong>.
        Ordenadas por acción pendiente: las que necesitan tu decisión arriba.
        Comparte con un arquitecto para que vea las postulaciones sin entrar
        a este sistema.
      </p>
      {rows.length === 0 && (
        <div className="card p-4 text-sm text-slate-500">
          No hay OTs listas para asignar en este momento.
        </div>
      )}
      <ul className="space-y-4">
        {rows.map(({ ot, posts, status }) => {
          const ranked = rankPostulaciones({
            postulaciones: posts,
            openPosByTecnico: openPosByTec,
            ratingByTecnico: ratingByTec,
            rateByTecnico: new Map(),
          });
          const publicUrl = `${origin}/publico/ot/${signOtPublicToken(ot.row_id)}`;
          const preselCount = posts.filter((p) => p.state === "preseleccionado").length;
          const postuladoCount = posts.filter((p) => p.state === "postulado").length;
          return (
            <li key={ot.row_id} className="card p-4">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="text-sm text-slate-500">
                    {ot.ciudad ?? "—"} · {ot.especialidad ?? "—"}
                  </div>
                  <div className="font-medium text-slate-900 truncate">
                    {otTitle(ot)}
                  </div>
                  <div className="text-[11px] text-slate-400 font-mono mt-0.5">
                    {ot.row_id.slice(0, 8)}
                  </div>
                </div>
                <div className="flex flex-col items-end gap-1 shrink-0">
                  <span
                    className={`text-xs rounded-full px-2 py-0.5 ${status.className}`}
                  >
                    {status.label}
                  </span>
                  <div className="text-[11px] text-slate-500 tabular-nums">
                    {posts.length === 0
                      ? "0 postulaciones"
                      : `${posts.length} ${posts.length === 1 ? "postulación" : "postulaciones"}${preselCount ? ` · ${preselCount} preseleccionada${preselCount === 1 ? "" : "s"}` : ""}${postuladoCount && preselCount ? ` · ${postuladoCount} esperando` : ""}`}
                  </div>
                </div>
              </div>

              {ranked.length > 0 && (
                <ul className="mt-3 space-y-1 text-sm">
                  {ranked.slice(0, 5).map((r) => (
                    <li
                      key={r.postulacion.id}
                      className="flex items-center justify-between border-t border-slate-100 pt-1"
                    >
                      <span className="text-slate-700">
                        {tecnicoLabel({
                          nombre: nombreByTec.get(r.postulacion.tecnico_id) ?? null,
                          ciudad: ciudadByTec.get(r.postulacion.tecnico_id) ?? null,
                        })}
                        {" · "}
                        <span className="text-slate-500">{r.postulacion.state}</span>
                      </span>
                      <span className="text-xs text-slate-500">
                        dispo {r.scores.disponibilidad.toFixed(2)} ·{" "}
                        calidad {r.scores.calidad?.toFixed(1) ?? "—"}
                      </span>
                    </li>
                  ))}
                  {ranked.length > 5 && (
                    <li className="text-xs text-slate-500 pt-1">
                      +{ranked.length - 5} más
                    </li>
                  )}
                </ul>
              )}

              <div className="mt-3 pt-3 border-t border-slate-100 flex items-center gap-4">
                <Link
                  href={`/hr/shortlist/${encodeURIComponent(ot.row_id)}`}
                  className="text-sm text-amber-600 hover:text-amber-700 font-medium"
                >
                  Ver postulaciones →
                </Link>
                <CopyShareLinkButton url={publicUrl} />
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
