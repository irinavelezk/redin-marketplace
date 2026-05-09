// HR shortlist view for a single OT — one-click preseleccionar / rechazar.
// Server actions write to `postulaciones` and log `shortlist_decided` events.

import { serverClientBoundToCookies, serviceClient } from "@/lib/supabase-server";
import { rankPostulaciones } from "@/lib/ranking";
import { enqueueWhatsApp, tecnicoNotificationContext } from "@/lib/notify";
import { otTitle, tecnicoLabel } from "@/lib/ot-display";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import type { PostulacionState } from "@redin/shared";
import Link from "next/link";

export const dynamic = "force-dynamic";

async function decide(formData: FormData) {
  "use server";
  const auth = serverClientBoundToCookies();
  const { data: userData } = await auth.auth.getUser();
  if (!userData.user) redirect("/login");
  const hrEmail = userData.user.email ?? userData.user.id;

  const supa = serviceClient();
  const postulacionId = formData.get("postulacion_id");
  const nextState = formData.get("state");
  const otId = formData.get("ot_id");
  if (typeof postulacionId !== "string" || typeof nextState !== "string" || typeof otId !== "string") {
    return;
  }
  const state = nextState as PostulacionState;
  const nowIso = new Date().toISOString();

  const { data: prior } = await supa
    .from("postulaciones")
    .select("id, state")
    .eq("id", postulacionId)
    .maybeSingle();

  const { error } = await supa
    .from("postulaciones")
    .update({
      state,
      decided_at: nowIso,
      decided_by: `hr:${hrEmail}`,
    })
    .eq("id", postulacionId);
  if (error) {
    console.error("decide failed", error);
    return;
  }

  await supa.from("eventos").insert({
    type: "shortlist_decided",
    entity_id: postulacionId,
    actor: `hr:${hrEmail}`,
    meta: {
      from_state: prior?.state ?? null,
      to_state: state,
      ot_id: otId,
    },
  });

  if (state === "preseleccionado") {
    const { data: post } = await supa
      .from("postulaciones")
      .select("tecnico_id")
      .eq("id", postulacionId)
      .maybeSingle();
    if (post?.tecnico_id) {
      const { phone, descripcion } = await tecnicoNotificationContext(
        supa,
        post.tecnico_id,
        otId
      );
      if (phone) {
        const trabajo = descripcion ?? "el trabajo";
        await enqueueWhatsApp(supa, {
          phone,
          body: `Buenas — quedaste preseleccionado para "${trabajo}". El cliente revisa tu perfil; te aviso apenas decidan.`,
          meta: { kind: "preseleccionado", postulacion_id: postulacionId, ot_id: otId },
        });
      }
    }
  }

  revalidatePath(`/hr/shortlist/${encodeURIComponent(otId)}`);
  revalidatePath("/hr/pipeline");
}

async function createContract(formData: FormData) {
  "use server";
  const auth = serverClientBoundToCookies();
  const { data: userData } = await auth.auth.getUser();
  if (!userData.user) redirect("/login");
  const hrEmail = userData.user.email ?? userData.user.id;

  const supa = serviceClient();
  const tecnicoId = formData.get("tecnico_id");
  const otId = formData.get("ot_id");
  if (typeof tecnicoId !== "string" || typeof otId !== "string") return;

  const { data: contract, error } = await supa
    .from("contratos")
    .insert({
      tecnico_id: tecnicoId,
      ot_id: otId,
      status: "borrador",
      created_by: `hr:${hrEmail}`,
    })
    .select("id")
    .single();
  if (error || !contract) {
    console.error("contract create failed", error);
    return;
  }

  await supa.from("eventos").insert({
    type: "contract_drafted",
    entity_id: contract.id,
    actor: `hr:${hrEmail}`,
    meta: { tecnico_id: tecnicoId, ot_id: otId },
  });

  const { phone, descripcion } = await tecnicoNotificationContext(supa, tecnicoId, otId);
  if (phone) {
    const trabajo = descripcion ?? "el trabajo";
    await enqueueWhatsApp(supa, {
      phone,
      body: `Avanzamos con el contrato de "${trabajo}". Te lo paso en un momento para que lo revises.`,
      meta: { kind: "contract_drafted", contract_id: contract.id, ot_id: otId },
    });
  }

  redirect(`/hr/contratos/${encodeURIComponent(contract.id)}`);
}

interface Props {
  params: { ot_id: string };
}

export default async function HrShortlistPage({ params }: Props) {
  const auth = serverClientBoundToCookies();
  const { data: userData } = await auth.auth.getUser();
  if (!userData.user) redirect("/login");

  const otId = decodeURIComponent(params.ot_id);
  const supa = serviceClient();

  const { data: ot } = await supa
    .from("ots_mirror")
    .select("row_id, ciudad, especialidad, estado, data")
    .eq("row_id", otId)
    .maybeSingle();
  const otHeadline = otTitle(ot);
  const { data: posts } = await supa
    .from("postulaciones")
    .select("*")
    .eq("ot_id", otId)
    .order("applied_at", { ascending: false });

  const tecnicoIds = [...new Set((posts ?? []).map((p) => p.tecnico_id))];
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

  // Migration 010: bulk-load nombre per applicant so the shortlist shows real
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
  // (the OT's ciudad is in the page header above each card).
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

  const ranked = rankPostulaciones({
    postulaciones: posts ?? [],
    openPosByTecnico: openPosByTec,
    ratingByTecnico: ratingByTec,
    rateByTecnico: new Map(),
  });

  return (
    <div className="space-y-4">
      <Link href="/hr/pipeline" className="text-sm text-slate-500 hover:text-slate-700">
        ← pipeline
      </Link>
      <div className="card p-4">
        <div className="text-sm text-slate-500">
          {ot?.ciudad ?? "—"} · {ot?.especialidad ?? "—"}
        </div>
        <div className="font-semibold text-slate-900 mt-0.5">{otHeadline}</div>
        <div className="text-sm text-slate-700 mt-1">{ot?.estado ?? "—"}</div>
        <div className="text-[11px] text-slate-400 font-mono mt-1">
          {otId.slice(0, 8)}
        </div>
      </div>
      <ul className="space-y-2">
        {ranked.map((r) => (
          <li key={r.postulacion.id} className="card p-4">
            <div className="flex items-center justify-between gap-2">
              <div>
                <Link
                  href={`/hr/tecnicos/${encodeURIComponent(r.postulacion.tecnico_id)}`}
                  className="font-medium text-slate-900 hover:text-amber-700"
                >
                  {tecnicoLabel({
                    nombre: nombreByTec.get(r.postulacion.tecnico_id) ?? null,
                    ciudad: ciudadByTec.get(r.postulacion.tecnico_id) ?? null,
                  })}
                </Link>
                <div className="text-xs text-slate-500">
                  Estado: {r.postulacion.state} · Aplicó{" "}
                  {new Date(r.postulacion.applied_at).toLocaleString("es-CO")}
                </div>
                <div className="text-xs text-slate-500 mt-1">
                  dispo {r.scores.disponibilidad.toFixed(2)} · calidad{" "}
                  {r.scores.calidad?.toFixed(1) ?? "—"}
                </div>
              </div>
              <div className="flex flex-col gap-1">
                <form action={decide}>
                  <input type="hidden" name="postulacion_id" value={r.postulacion.id} />
                  <input type="hidden" name="ot_id" value={otId} />
                  <input type="hidden" name="state" value="preseleccionado" />
                  <button
                    type="submit"
                    className="text-xs bg-amber-500 hover:bg-amber-600 text-white rounded-md px-3 py-1"
                    disabled={r.postulacion.state === "preseleccionado" || r.postulacion.state === "asignado"}
                  >
                    Preseleccionar
                  </button>
                </form>
                <form action={decide}>
                  <input type="hidden" name="postulacion_id" value={r.postulacion.id} />
                  <input type="hidden" name="ot_id" value={otId} />
                  <input type="hidden" name="state" value="rechazado" />
                  <button
                    type="submit"
                    className="text-xs border border-slate-300 hover:bg-slate-50 text-slate-700 rounded-md px-3 py-1"
                  >
                    Rechazar
                  </button>
                </form>
                {r.postulacion.state === "preseleccionado" && (
                  <form action={createContract}>
                    <input type="hidden" name="tecnico_id" value={r.postulacion.tecnico_id} />
                    <input type="hidden" name="ot_id" value={otId} />
                    <button
                      type="submit"
                      className="text-xs bg-slate-900 hover:bg-slate-800 text-white rounded-md px-3 py-1"
                    >
                      Generar contrato
                    </button>
                  </form>
                )}
              </div>
            </div>
          </li>
        ))}
        {ranked.length === 0 && (
          <li className="card p-4 text-sm text-slate-500">
            Sin postulaciones para esta OT.
          </li>
        )}
      </ul>
    </div>
  );
}
