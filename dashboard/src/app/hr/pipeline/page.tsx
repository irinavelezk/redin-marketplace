// HR pipeline — OTs and their postulaciones, ranked by disponibilidad → calidad → costo.
// Auth-gated via Supabase Auth.

import { serverClientBoundToCookies, serviceClient } from "@/lib/supabase-server";
import { rankPostulaciones } from "@/lib/ranking";
import { otTitle, tecnicoLabel } from "@/lib/ot-display";
import type { PostulacionRow } from "@redin/shared";
import { redirect } from "next/navigation";
import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function HrPipelinePage() {
  const auth = serverClientBoundToCookies();
  const { data: userData } = await auth.auth.getUser();
  if (!userData.user) redirect("/login");

  const supa = serviceClient();

  // Two-source pull so OTs with postulaciones can never be hidden by the
  // recency cutoff. Source A: every OT that has any postulación (so HR sees
  // actionable items even if the OT was synced days ago). Source B: top 30
  // most-recently-synced OTs (so HR can also see open work nobody applied to).
  // Merged + deduped, A first.
  const { data: allPosts } = await supa
    .from("postulaciones")
    .select("*");
  const otIdsWithPosts = [...new Set((allPosts ?? []).map((p) => p.ot_id))];

  const { data: otsWithPosts } = otIdsWithPosts.length
    ? await supa
        .from("ots_mirror")
        .select("row_id, ciudad, especialidad, estado, data, synced_at")
        .in("row_id", otIdsWithPosts)
        .order("synced_at", { ascending: false })
    : { data: [] };

  const { data: otsRecent } = await supa
    .from("ots_mirror")
    .select("row_id, ciudad, especialidad, estado, data, synced_at")
    .order("synced_at", { ascending: false })
    .limit(30);
  const seen = new Set<string>();
  const ots: NonNullable<typeof otsRecent> = [];
  for (const o of otsWithPosts ?? []) {
    if (!seen.has(o.row_id)) {
      seen.add(o.row_id);
      ots.push(o);
    }
  }
  for (const o of otsRecent ?? []) {
    if (!seen.has(o.row_id)) {
      seen.add(o.row_id);
      ots.push(o);
    }
  }

  const pendingOts = ots.filter(
    (o) => !o.estado || !["Terminado", "Facturado", "Pagado", "99. Perdida / Cancelada"].includes(o.estado)
  );

  // allPosts above already covers what we need; the per-OT mapping below
  // filters to just these pendingOts.
  const otIds = pendingOts.map((o) => o.row_id);
  void otIds;
  const allPostsForPending: PostulacionRow[] = (allPosts ?? []).filter((p) =>
    seen.has(p.ot_id)
  );

  // Internal performance (Jose + arquitectos via /hr/evaluations). Replaces
  // the legacy customer-stars ratings — Phase 1 has no direct customer
  // relationship, so calidad is scored from inside.
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

  // Migration 010: bulk-load nombre per applicant so the pipeline shows real
  // names instead of `tecnico_id.slice(0, 8)`. Falls back to the prefix when
  // the column is null on legacy rows.
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

  // Worker ciudad lives in eventos.meta.ciudad (tecnico_registered) — not on
  // tecnicos_extended. Bulk-load so HR can spot worker-vs-OT city mismatches
  // without clicking through to the worker detail.
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

  // Group posts by ot.
  const postsByOt = new Map<string, PostulacionRow[]>();
  for (const p of allPostsForPending) {
    if (!postsByOt.has(p.ot_id)) postsByOt.set(p.ot_id, []);
    postsByOt.get(p.ot_id)!.push(p);
  }

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
        OTs abiertas con postulaciones. Orden: disponibilidad → calidad → costo.
      </p>
      <ul className="space-y-4">
        {pendingOts.map((ot) => {
          const posts = postsByOt.get(ot.row_id) ?? [];
          const ranked = rankPostulaciones({
            postulaciones: posts,
            openPosByTecnico: openPosByTec,
            ratingByTecnico: ratingByTec,
            rateByTecnico: new Map(),
          });
          return (
            <li key={ot.row_id} className="card p-4">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="text-sm text-slate-500">
                    {ot.ciudad ?? "—"} · {ot.especialidad ?? "—"} · {ot.estado ?? "—"}
                  </div>
                  <div className="font-medium text-slate-900 truncate">
                    {otTitle(ot)}
                  </div>
                  <div className="text-[11px] text-slate-400 font-mono mt-0.5">
                    {ot.row_id.slice(0, 8)}
                  </div>
                </div>
                <Link
                  href={`/hr/shortlist/${encodeURIComponent(ot.row_id)}`}
                  className="text-sm text-amber-600 hover:text-amber-700 font-medium shrink-0"
                >
                  Shortlist →
                </Link>
              </div>
              {posts.length === 0 ? (
                <div className="mt-2 text-sm text-slate-500">
                  Sin postulaciones aún.
                </div>
              ) : (
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
            </li>
          );
        })}
      </ul>
    </div>
  );
}
