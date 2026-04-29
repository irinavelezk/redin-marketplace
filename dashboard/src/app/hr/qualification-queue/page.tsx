// HR qualification queue — workers with qualification_state in (pending, needs_review).
// Approve / reject / schedule call. Each action updates tecnicos_extended,
// logs an eventos row, and notifies the worker via WhatsApp (outbound_messages).

import { serverClientBoundToCookies, serviceClient } from "@/lib/supabase-server";
import { enqueueWhatsApp } from "@/lib/notify";
import type { QualificationState } from "@redin/shared";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import Link from "next/link";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Server actions
// ---------------------------------------------------------------------------

async function decide(formData: FormData) {
  "use server";
  const auth = serverClientBoundToCookies();
  const { data: userData } = await auth.auth.getUser();
  if (!userData.user) redirect("/login");
  const hrEmail = userData.user.email ?? userData.user.id;

  const tecnicoId = formData.get("tecnico_id");
  const decision = formData.get("decision");
  const notes = formData.get("notes");
  if (typeof tecnicoId !== "string" || typeof decision !== "string") return;

  const allowed: Record<string, QualificationState> = {
    approve: "qualified",
    reject: "rejected",
    schedule_call: "needs_call",
  };
  const nextState = allowed[decision];
  if (!nextState) return;

  const supa = serviceClient();

  const { data: prior } = await supa
    .from("tecnicos_extended")
    .select("tecnico_id, phone, qualification_state")
    .eq("tecnico_id", tecnicoId)
    .maybeSingle();
  if (!prior) return;

  const { error: updateErr } = await supa
    .from("tecnicos_extended")
    .update({ qualification_state: nextState })
    .eq("tecnico_id", tecnicoId);
  if (updateErr) {
    console.error("qualification update failed", updateErr);
    return;
  }

  await supa.from("eventos").insert({
    type: "qualification_decided",
    entity_id: tecnicoId,
    actor: `hr:${hrEmail}`,
    meta: {
      from_state: prior.qualification_state,
      to_state: nextState,
      notes: typeof notes === "string" ? notes.trim() || null : null,
    },
  });

  // Notify the worker. Body matches the agent's prompt vocabulary so the
  // técnico's mental model stays consistent across surfaces.
  const phone = prior.phone;
  if (phone) {
    let body: string | null = null;
    if (nextState === "qualified") {
      body =
        "Listo — tu perfil quedó aprobado. Ya puedes postularte a los trabajos que te muestre. Cuando entre algo que te sirva, te aviso.";
    } else if (nextState === "rejected") {
      body =
        "Hola, revisamos tu perfil y por ahora no podemos seguir adelante. Si quieres conversarlo, puedes responder y te contactamos.";
    } else if (nextState === "needs_call") {
      body =
        "Queremos hacerte una llamada corta para conocerte mejor antes de avanzar. Pronto te contactamos para coordinar.";
    }
    if (body) {
      await enqueueWhatsApp(supa, {
        phone,
        body,
        meta: {
          kind: "qualification_decided",
          tecnico_id: tecnicoId,
          to_state: nextState,
        },
      });
    }
  }

  revalidatePath("/hr/qualification-queue");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface RegisteredMeta {
  nombre?: string;
  ciudad?: string;
  especialidades?: string[];
  modalidad?: string;
}

interface ReviewMeta {
  summary?: string;
  prior_state?: string;
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
  const out: ReviewMeta = {};
  if (typeof m.summary === "string") out.summary = m.summary;
  if (typeof m.prior_state === "string") out.prior_state = m.prior_state;
  return out;
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default async function HrQualificationQueuePage() {
  const auth = serverClientBoundToCookies();
  const { data: userData } = await auth.auth.getUser();
  if (!userData.user) redirect("/login");

  const supa = serviceClient();

  // pending      = Toño still gathering
  // needs_review = ready for HR
  // needs_call   = HR asked for a call; surface so HR can come back after the
  //                call and approve / reject. (If we filtered this out, the
  //                worker would silently disappear from the queue the moment
  //                "Pedir llamada" gets clicked.)
  const { data: tecnicos } = await supa
    .from("tecnicos_extended")
    .select("*")
    .in("qualification_state", ["pending", "needs_review", "needs_call"])
    .order("onboarded_at", { ascending: false })
    .limit(100);

  const ids = (tecnicos ?? []).map((t) => t.tecnico_id);
  const { data: regEvents } = ids.length
    ? await supa
        .from("eventos")
        .select("entity_id, meta, created_at")
        .eq("type", "tecnico_registered")
        .in("entity_id", ids)
        .order("created_at", { ascending: false })
    : { data: [] };
  const { data: reviewEvents } = ids.length
    ? await supa
        .from("eventos")
        .select("entity_id, meta, created_at")
        .eq("type", "qualification_review_requested")
        .in("entity_id", ids)
        .order("created_at", { ascending: false })
    : { data: [] };

  // Take the latest of each event type per tecnico.
  const regByTec = new Map<string, RegisteredMeta>();
  for (const e of regEvents ?? []) {
    if (!e.entity_id || regByTec.has(e.entity_id)) continue;
    regByTec.set(e.entity_id, parseRegisteredMeta(e.meta));
  }
  const reviewByTec = new Map<string, ReviewMeta>();
  for (const e of reviewEvents ?? []) {
    if (!e.entity_id || reviewByTec.has(e.entity_id)) continue;
    reviewByTec.set(e.entity_id, parseReviewMeta(e.meta));
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-slate-900">Cola de calificación</h1>
        <Link
          href="/hr/pipeline"
          className="text-sm text-slate-500 hover:text-slate-700"
        >
          Pipeline →
        </Link>
      </div>
      <p className="text-sm text-slate-600">
        Técnicos esperando aprobación. <strong>needs_review</strong> = Toño ya
        recogió contexto suficiente. <strong>pending</strong> = aún en charla;
        puedes aprobar tú si conoces al técnico de antes.{" "}
        <strong>needs_call</strong> = pediste una llamada; vuelve aquí después
        de hacerla y aprueba o rechaza.
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
            const stateClass =
              tec.qualification_state === "needs_review"
                ? "text-emerald-600 font-medium"
                : tec.qualification_state === "needs_call"
                ? "text-blue-600 font-medium"
                : "text-amber-600";
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
                      <span className={stateClass}>{tec.qualification_state}</span>
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
                    <form action={decide}>
                      <input type="hidden" name="tecnico_id" value={tec.tecnico_id} />
                      <input type="hidden" name="decision" value="approve" />
                      <button
                        type="submit"
                        className="text-xs bg-emerald-600 hover:bg-emerald-700 text-white rounded-md px-3 py-1 w-32"
                      >
                        Aprobar
                      </button>
                    </form>
                    <form action={decide}>
                      <input type="hidden" name="tecnico_id" value={tec.tecnico_id} />
                      <input type="hidden" name="decision" value="schedule_call" />
                      <button
                        type="submit"
                        className="text-xs bg-amber-500 hover:bg-amber-600 text-white rounded-md px-3 py-1 w-32"
                      >
                        Pedir llamada
                      </button>
                    </form>
                    <form action={decide}>
                      <input type="hidden" name="tecnico_id" value={tec.tecnico_id} />
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
