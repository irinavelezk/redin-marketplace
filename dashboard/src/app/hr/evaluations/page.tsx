// HR / Jose / arquitecto evaluations — score técnicos who worked or are
// working on an OT. Four 1-5 dimensions + recommend_rehire + free notes.
// Multiple evaluators per OT are allowed (Jose AND the supervising arquitecto
// can score independently); the unique constraint is per evaluator.

import { serverClientBoundToCookies, serviceClient } from "@/lib/supabase-server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import Link from "next/link";

export const dynamic = "force-dynamic";

const DIMENSIONS = [
  { key: "cumplimiento", label: "Cumplimiento (alcance / plazos)" },
  { key: "calidad", label: "Calidad técnica" },
  { key: "actitud", label: "Actitud / colaboración" },
  { key: "puntualidad", label: "Puntualidad" },
] as const;

// ---------------------------------------------------------------------------
// Server action
// ---------------------------------------------------------------------------

function readScore(formData: FormData, key: string): number | null {
  const raw = formData.get(key);
  if (typeof raw !== "string" || raw === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1 || n > 5) return null;
  return Math.round(n);
}

async function submitEvaluation(formData: FormData) {
  "use server";
  const auth = serverClientBoundToCookies();
  const { data: userData } = await auth.auth.getUser();
  if (!userData.user) redirect("/login");
  const hrEmail = userData.user.email ?? userData.user.id;

  const tecnicoId = formData.get("tecnico_id");
  const otId = formData.get("ot_id");
  const evaluatorRaw = formData.get("evaluator");
  if (typeof tecnicoId !== "string" || typeof otId !== "string") return;

  // Default to "hr:<email>"; allow Jose / arquitectos to override the evaluator
  // string from the form so we can attribute beyond the logged-in HR user.
  const evaluator =
    typeof evaluatorRaw === "string" && evaluatorRaw.trim().length > 0
      ? evaluatorRaw.trim()
      : `hr:${hrEmail}`;

  const cumplimiento = readScore(formData, "cumplimiento");
  const calidad = readScore(formData, "calidad");
  const actitud = readScore(formData, "actitud");
  const puntualidad = readScore(formData, "puntualidad");

  const rehireRaw = formData.get("recommend_rehire");
  const recommendRehire =
    rehireRaw === "yes" ? true : rehireRaw === "no" ? false : null;

  const notesRaw = formData.get("notes");
  const notes =
    typeof notesRaw === "string" && notesRaw.trim().length > 0
      ? notesRaw.trim()
      : null;

  const supa = serviceClient();

  // Upsert on (tecnico_id, ot_id, evaluator) — unique constraint from 003.
  const { error } = await supa
    .from("tecnico_evaluations")
    .upsert(
      {
        tecnico_id: tecnicoId,
        ot_id: otId,
        evaluator,
        cumplimiento,
        calidad,
        actitud,
        puntualidad,
        recommend_rehire: recommendRehire,
        notes,
      },
      { onConflict: "tecnico_id,ot_id,evaluator" }
    );
  if (error) {
    console.error("evaluation upsert failed", error);
    return;
  }

  await supa.from("eventos").insert({
    type: "tecnico_evaluated",
    entity_id: tecnicoId,
    actor: `hr:${hrEmail}`,
    meta: {
      ot_id: otId,
      evaluator,
      cumplimiento,
      calidad,
      actitud,
      puntualidad,
      recommend_rehire: recommendRehire,
    },
  });

  revalidatePath("/hr/evaluations");
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

interface ExistingEval {
  evaluator: string;
  cumplimiento: number | null;
  calidad: number | null;
  actitud: number | null;
  puntualidad: number | null;
  recommend_rehire: boolean | null;
  notes: string | null;
}

export default async function HrEvaluationsPage() {
  const auth = serverClientBoundToCookies();
  const { data: userData } = await auth.auth.getUser();
  if (!userData.user) redirect("/login");
  const hrEmail = userData.user.email ?? userData.user.id;

  const supa = serviceClient();

  // Show postulaciones that reached the work stage (assigned or completed).
  // Anything earlier doesn't have observable performance yet.
  const { data: posts } = await supa
    .from("postulaciones")
    .select("id, ot_id, tecnico_id, state, applied_at, decided_at")
    .in("state", ["asignado", "completado"])
    .order("decided_at", { ascending: false, nullsFirst: false })
    .limit(50);

  const otIds = [...new Set((posts ?? []).map((p) => p.ot_id))];
  const tecIds = [...new Set((posts ?? []).map((p) => p.tecnico_id))];

  const { data: ots } = otIds.length
    ? await supa
        .from("ots_mirror")
        .select("row_id, ciudad, especialidad, data")
        .in("row_id", otIds)
    : { data: [] };
  const otByRowId = new Map(
    (ots ?? []).map((o) => [
      o.row_id,
      {
        ciudad: o.ciudad,
        especialidad: o.especialidad,
        descripcion: descripcionFrom(o.data),
      },
    ])
  );

  const { data: tecs } = tecIds.length
    ? await supa
        .from("tecnicos_extended")
        .select("tecnico_id, phone")
        .in("tecnico_id", tecIds)
    : { data: [] };
  const tecByIdNombre = new Map<string, string>();
  // Pull the latest tecnico_registered event per tecnico for nombre.
  if (tecIds.length) {
    const { data: regEvents } = await supa
      .from("eventos")
      .select("entity_id, meta, created_at")
      .eq("type", "tecnico_registered")
      .in("entity_id", tecIds)
      .order("created_at", { ascending: false });
    for (const e of regEvents ?? []) {
      if (!e.entity_id || tecByIdNombre.has(e.entity_id)) continue;
      const m = e.meta;
      if (m && typeof m === "object" && !Array.isArray(m)) {
        const nombre = (m as Record<string, unknown>).nombre;
        if (typeof nombre === "string") tecByIdNombre.set(e.entity_id, nombre);
      }
    }
  }

  // Pull existing evaluations from THIS hr user, so the form can show
  // pre-filled values and "you've already evaluated this" hint.
  const myEvaluator = `hr:${hrEmail}`;
  const { data: existingEvals } = posts && posts.length
    ? await supa
        .from("tecnico_evaluations")
        .select("*")
        .in(
          "ot_id",
          posts.map((p) => p.ot_id)
        )
        .in(
          "tecnico_id",
          posts.map((p) => p.tecnico_id)
        )
        .eq("evaluator", myEvaluator)
    : { data: [] };
  const existingByKey = new Map<string, ExistingEval>();
  for (const e of existingEvals ?? []) {
    existingByKey.set(`${e.tecnico_id}::${e.ot_id}`, e as ExistingEval);
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-slate-900">Evaluaciones</h1>
        <Link href="/hr/pipeline" className="text-sm text-slate-500 hover:text-slate-700">
          Pipeline →
        </Link>
      </div>
      <p className="text-sm text-slate-600">
        Califica a los técnicos que trabajaron en cada OT. Las cuatro dimensiones
        van de 1 (mal) a 5 (excelente). Si tú eres Jose o un arquitecto,
        sobrescribe el campo evaluador con tu nombre.
      </p>

      {(posts ?? []).length === 0 ? (
        <div className="card p-4 text-sm text-slate-500">
          No hay postulaciones en estado asignado o completado.
        </div>
      ) : (
        <ul className="space-y-3">
          {(posts ?? []).map((p) => {
            const ot = otByRowId.get(p.ot_id);
            const nombre = tecByIdNombre.get(p.tecnico_id) ?? null;
            const existing = existingByKey.get(`${p.tecnico_id}::${p.ot_id}`);
            return (
              <li key={p.id} className="card p-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <Link
                      href={`/hr/tecnicos/${encodeURIComponent(p.tecnico_id)}`}
                      className="font-medium text-slate-900 hover:text-amber-700"
                    >
                      {nombre ?? "(sin nombre)"}
                    </Link>
                    <div className="text-xs text-slate-500 mt-0.5">
                      {ot?.ciudad ?? "—"} · {ot?.especialidad ?? "—"} · {p.state}
                    </div>
                    {ot?.descripcion && (
                      <div className="text-sm text-slate-700 mt-1 line-clamp-2">
                        {ot.descripcion}
                      </div>
                    )}
                    {existing && (
                      <div className="text-xs text-emerald-700 mt-1">
                        Ya evaluaste — los campos abajo muestran tu evaluación
                        previa; envío re-escribe.
                      </div>
                    )}
                  </div>
                </div>
                <form action={submitEvaluation} className="mt-3 space-y-2">
                  <input type="hidden" name="tecnico_id" value={p.tecnico_id} />
                  <input type="hidden" name="ot_id" value={p.ot_id} />

                  <div className="grid grid-cols-2 gap-2">
                    {DIMENSIONS.map((d) => (
                      <label key={d.key} className="text-sm">
                        <span className="block text-slate-600">{d.label}</span>
                        <select
                          name={d.key}
                          defaultValue={
                            existing?.[d.key as keyof ExistingEval]?.toString() ??
                            ""
                          }
                          className="mt-0.5 w-full border border-slate-300 rounded px-2 py-1 text-sm"
                        >
                          <option value="">—</option>
                          <option value="1">1</option>
                          <option value="2">2</option>
                          <option value="3">3</option>
                          <option value="4">4</option>
                          <option value="5">5</option>
                        </select>
                      </label>
                    ))}
                  </div>

                  <label className="text-sm block">
                    <span className="block text-slate-600">¿Lo volverías a contratar?</span>
                    <select
                      name="recommend_rehire"
                      defaultValue={
                        existing?.recommend_rehire === true
                          ? "yes"
                          : existing?.recommend_rehire === false
                          ? "no"
                          : ""
                      }
                      className="mt-0.5 border border-slate-300 rounded px-2 py-1 text-sm"
                    >
                      <option value="">—</option>
                      <option value="yes">Sí</option>
                      <option value="no">No</option>
                    </select>
                  </label>

                  <label className="text-sm block">
                    <span className="block text-slate-600">Evaluador</span>
                    <input
                      type="text"
                      name="evaluator"
                      defaultValue={existing?.evaluator ?? `hr:${hrEmail}`}
                      placeholder="ej: jose, arquitecto:laura, hr:..."
                      className="mt-0.5 w-full border border-slate-300 rounded px-2 py-1 text-sm"
                    />
                  </label>

                  <label className="text-sm block">
                    <span className="block text-slate-600">Notas (opcional)</span>
                    <textarea
                      name="notes"
                      rows={2}
                      defaultValue={existing?.notes ?? ""}
                      className="mt-0.5 w-full border border-slate-300 rounded px-2 py-1 text-sm"
                    />
                  </label>

                  <div className="flex justify-end">
                    <button
                      type="submit"
                      className="text-xs bg-slate-900 hover:bg-slate-800 text-white rounded-md px-3 py-1"
                    >
                      Guardar evaluación
                    </button>
                  </div>
                </form>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// Local descriptor extraction — same heuristic as the tools package and other
// HR pages. Kept inline because the dashboard already uses Json from shared.
function descripcionFrom(data: unknown): string {
  if (!data || typeof data !== "object" || Array.isArray(data)) return "";
  const d = data as Record<string, unknown>;
  for (const k of ["Descripcion", "descripcion", "Resumen Visual", "Actividad_Descripcion"]) {
    const v = d[k];
    if (typeof v === "string" && v.trim().length > 0) return v.trim();
  }
  return "";
}
