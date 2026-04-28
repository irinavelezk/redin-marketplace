// HR pipeline — OTs and their postulaciones, ranked by disponibilidad → calidad → costo.
// Auth-gated via Supabase Auth.

import { serverClientBoundToCookies, serviceClient } from "@/lib/supabase-server";
import { rankPostulaciones } from "@/lib/ranking";
import type { PostulacionRow } from "@redin/shared";
import { redirect } from "next/navigation";
import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function HrPipelinePage() {
  const auth = serverClientBoundToCookies();
  const { data: userData } = await auth.auth.getUser();
  if (!userData.user) redirect("/login");

  const supa = serviceClient();
  const { data: ots } = await supa
    .from("ots_mirror")
    .select("row_id, ciudad, especialidad, estado, data")
    .order("synced_at", { ascending: false })
    .limit(50);

  const pendingOts = (ots ?? []).filter(
    (o) => !o.estado || !["Terminado", "Facturado", "Pagado", "99. Perdida / Cancelada"].includes(o.estado)
  );

  // Fetch postulaciones for just these OTs in one round-trip.
  const otIds = pendingOts.map((o) => o.row_id);
  const { data: allPosts } = otIds.length
    ? await supa.from("postulaciones").select("*").in("ot_id", otIds)
    : { data: [] as PostulacionRow[] };

  // Ratings + open-load maps for ranking.
  const tecnicoIds = [...new Set((allPosts ?? []).map((p) => p.tecnico_id))];
  const { data: ratings } = tecnicoIds.length
    ? await supa.from("ratings").select("ratee, stars").in("ratee", tecnicoIds)
    : { data: [] };

  const ratingByTec = new Map<string, number | null>();
  const rateCount = new Map<string, number>();
  const rateSum = new Map<string, number>();
  for (const r of ratings ?? []) {
    rateCount.set(r.ratee, (rateCount.get(r.ratee) ?? 0) + 1);
    rateSum.set(r.ratee, (rateSum.get(r.ratee) ?? 0) + (r.stars ?? 0));
  }
  for (const id of tecnicoIds) {
    const c = rateCount.get(id);
    if (!c) ratingByTec.set(id, null);
    else ratingByTec.set(id, (rateSum.get(id) ?? 0) / c);
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

  // Group posts by ot.
  const postsByOt = new Map<string, PostulacionRow[]>();
  for (const p of allPosts ?? []) {
    if (!postsByOt.has(p.ot_id)) postsByOt.set(p.ot_id, []);
    postsByOt.get(p.ot_id)!.push(p);
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-slate-900">Pipeline HR</h1>
        <Link
          href="/hr/qualification-queue"
          className="text-sm text-amber-600 hover:text-amber-700 font-medium"
        >
          Cola de calificación →
        </Link>
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
              <div className="flex items-start justify-between">
                <div>
                  <div className="text-sm text-slate-500">
                    {ot.ciudad ?? "—"} · {ot.especialidad ?? "—"} · {ot.estado ?? "—"}
                  </div>
                  <div className="font-medium text-slate-900">{ot.row_id}</div>
                </div>
                <Link
                  href={`/hr/shortlist/${encodeURIComponent(ot.row_id)}`}
                  className="text-sm text-amber-600 hover:text-amber-700 font-medium"
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
                        {r.postulacion.tecnico_id.slice(0, 8)} ·{" "}
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
