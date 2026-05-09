// HR técnicos roster — every worker the system knows about, with their
// candidate_state, postulaciones count, contratos firmados, and the
// timestamp of the last HR decision. Read-only; actions live on the
// qualification-queue, pipeline, and evaluations pages so each surface keeps
// a single purpose.

import { serverClientBoundToCookies, serviceClient } from "@/lib/supabase-server";
import type { CandidateState } from "@redin/shared";
import { redirect } from "next/navigation";
import Link from "next/link";

export const dynamic = "force-dynamic";

const STATE_CLASS: Record<CandidateState, string> = {
  screening: "bg-slate-100 text-slate-700",
  pending: "bg-amber-100 text-amber-800",
  needs_call: "bg-violet-100 text-violet-800",
  approved: "bg-emerald-100 text-emerald-800",
  rejected: "bg-rose-100 text-rose-800",
  withdrawn: "bg-slate-100 text-slate-500",
  revoked: "bg-rose-200 text-rose-900",
};

function parseRegisteredMeta(meta: unknown): {
  nombre?: string;
  ciudad?: string;
  especialidades?: string[];
  modalidad?: string;
} {
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

interface DecisionMeta {
  to_state?: string;
  from_state?: string;
}

// Decision events come in two shapes:
//   legacy 'qualification_decided': meta.to_state, meta.from_state
//   new    'hr_decision':           meta.resulting_state, meta.prior_state
// Normalize to the legacy keys so the table renderer below stays unchanged.
function parseDecisionMeta(meta: unknown): DecisionMeta {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return {};
  const m = meta as Record<string, unknown>;
  return {
    to_state:
      typeof m.to_state === "string"
        ? m.to_state
        : typeof m.resulting_state === "string"
        ? m.resulting_state
        : undefined,
    from_state:
      typeof m.from_state === "string"
        ? m.from_state
        : typeof m.prior_state === "string"
        ? m.prior_state
        : undefined,
  };
}

export default async function HrTecnicosPage({
  searchParams,
}: {
  searchParams?: { state?: string };
}) {
  const auth = serverClientBoundToCookies();
  const { data: userData } = await auth.auth.getUser();
  if (!userData.user) redirect("/login");

  const supa = serviceClient();
  const stateFilter = searchParams?.state;

  let query = supa
    .from("tecnicos_extended")
    .select("*")
    .order("onboarded_at", { ascending: false })
    .limit(200);
  if (
    stateFilter === "screening" ||
    stateFilter === "pending" ||
    stateFilter === "needs_call" ||
    stateFilter === "approved" ||
    stateFilter === "rejected" ||
    stateFilter === "withdrawn" ||
    stateFilter === "revoked"
  ) {
    query = query.eq("candidate_state", stateFilter);
  }
  const { data: tecnicos } = await query;

  const ids = (tecnicos ?? []).map((t) => t.tecnico_id);
  const phones = (tecnicos ?? []).map((t) => t.phone);

  // Latest registration event (nombre/ciudad/especialidades) per worker
  const { data: regEvents } = ids.length
    ? await supa
        .from("eventos")
        .select("entity_id, meta, created_at")
        .eq("type", "tecnico_registered")
        .in("entity_id", ids)
        .order("created_at", { ascending: false })
    : { data: [] };
  const regByTec = new Map<string, ReturnType<typeof parseRegisteredMeta>>();
  for (const e of regEvents ?? []) {
    if (!e.entity_id || regByTec.has(e.entity_id)) continue;
    regByTec.set(e.entity_id, parseRegisteredMeta(e.meta));
  }

  // Latest HR decision event per worker (when + by whom). Read both the new
  // 'hr_decision' name (commit 1+) and the legacy 'qualification_decided' so
  // pre-merge rows remain visible without a separate migration.
  const { data: decisionEvents } = ids.length
    ? await supa
        .from("eventos")
        .select("entity_id, actor, meta, created_at")
        .in("type", ["hr_decision", "qualification_decided"])
        .in("entity_id", ids)
        .order("created_at", { ascending: false })
    : { data: [] };
  interface DecisionInfo {
    to_state?: string;
    actor: string | null;
    at: string;
  }
  const lastDecisionByTec = new Map<string, DecisionInfo>();
  for (const e of decisionEvents ?? []) {
    if (!e.entity_id || lastDecisionByTec.has(e.entity_id)) continue;
    const m = parseDecisionMeta(e.meta);
    lastDecisionByTec.set(e.entity_id, {
      to_state: m.to_state,
      actor: e.actor,
      at: e.created_at,
    });
  }

  // Postulaciones per worker — total + grouped by state
  const { data: posRows } = ids.length
    ? await supa.from("postulaciones").select("tecnico_id, state").in("tecnico_id", ids)
    : { data: [] };
  const postCount = new Map<string, number>();
  const asignadoCount = new Map<string, number>();
  for (const p of posRows ?? []) {
    postCount.set(p.tecnico_id, (postCount.get(p.tecnico_id) ?? 0) + 1);
    if (p.state === "asignado") {
      asignadoCount.set(p.tecnico_id, (asignadoCount.get(p.tecnico_id) ?? 0) + 1);
    }
  }

  // Contratos firmados per worker
  const { data: contratos } = ids.length
    ? await supa
        .from("contratos")
        .select("tecnico_id, status")
        .in("tecnico_id", ids)
        .eq("status", "firmado")
    : { data: [] };
  const firmadoCount = new Map<string, number>();
  for (const c of contratos ?? []) {
    firmadoCount.set(c.tecnico_id, (firmadoCount.get(c.tecnico_id) ?? 0) + 1);
  }

  void phones; // placeholder for future phone-search filter

  const filterChips: { label: string; value: string | undefined }[] = [
    { label: "Todos", value: undefined },
    { label: "En charla", value: "screening" },
    { label: "Pendientes", value: "pending" },
    { label: "Llamada pendiente", value: "needs_call" },
    { label: "Aprobados", value: "approved" },
    { label: "Rechazados", value: "rejected" },
    { label: "Retirados", value: "withdrawn" },
    { label: "Revocados", value: "revoked" },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-slate-900">Técnicos</h1>
        <div className="flex items-center gap-3">
          <Link
            href="/hr/qualification-queue"
            className="text-sm text-amber-600 hover:text-amber-700 font-medium"
          >
            Cola de calificación →
          </Link>
          <Link href="/hr/pipeline" className="text-sm text-slate-500 hover:text-slate-700">
            Pipeline →
          </Link>
          <Link href="/hr/contratos" className="text-sm text-slate-500 hover:text-slate-700">
            Contratos →
          </Link>
        </div>
      </div>

      <div className="flex flex-wrap gap-2 text-sm">
        {filterChips.map((c) => {
          const active = (c.value ?? "") === (stateFilter ?? "");
          const href = c.value ? `/hr/tecnicos?state=${c.value}` : "/hr/tecnicos";
          return (
            <Link
              key={c.label}
              href={href}
              className={
                active
                  ? "bg-slate-900 text-white rounded-full px-3 py-1"
                  : "bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-full px-3 py-1"
              }
            >
              {c.label}
            </Link>
          );
        })}
      </div>

      <p className="text-sm text-slate-600">
        Roster completo. Para tomar decisiones de calificación ve a{" "}
        <Link href="/hr/qualification-queue" className="text-amber-600 hover:text-amber-700">
          Cola de calificación
        </Link>
        ; para preseleccionar y contratos ve a{" "}
        <Link href="/hr/pipeline" className="text-amber-600 hover:text-amber-700">
          Pipeline
        </Link>
        .
      </p>

      {(tecnicos ?? []).length === 0 ? (
        <div className="card p-4 text-sm text-slate-500">
          No hay técnicos con ese filtro.
        </div>
      ) : (
        <div className="overflow-x-auto card">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-600 text-xs uppercase tracking-wide">
              <tr>
                <th className="text-left px-3 py-2">Nombre / phone</th>
                <th className="text-left px-3 py-2">Ciudad</th>
                <th className="text-left px-3 py-2">Estado</th>
                <th className="text-right px-3 py-2">Postulaciones</th>
                <th className="text-right px-3 py-2">Asignados</th>
                <th className="text-right px-3 py-2">Contratos firmados</th>
                <th className="text-left px-3 py-2">Última decisión</th>
              </tr>
            </thead>
            <tbody>
              {(tecnicos ?? []).map((t) => {
                const reg = regByTec.get(t.tecnico_id);
                const dec = lastDecisionByTec.get(t.tecnico_id);
                const stateClass =
                  STATE_CLASS[t.candidate_state] ?? "bg-slate-100 text-slate-700";
                return (
                  <tr key={t.tecnico_id} className="border-t border-slate-100">
                    <td className="px-3 py-2">
                      <Link
                        href={`/hr/tecnicos/${encodeURIComponent(t.tecnico_id)}`}
                        className="font-medium text-slate-900 hover:text-amber-700"
                      >
                        {t.nombre ?? reg?.nombre ?? "—"}
                      </Link>
                      <div className="text-xs">
                        {t.contact_phone ? (
                          <a
                            href={`tel:${t.contact_phone}`}
                            className="text-slate-700 font-medium hover:underline underline-offset-2"
                          >
                            📞 {t.contact_phone}
                          </a>
                        ) : (
                          <span className="text-slate-400">Sin teléfono de contacto</span>
                        )}
                        <div className="text-slate-400">WA {t.phone}</div>
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      <div className="text-slate-700">{reg?.ciudad ?? "—"}</div>
                      {reg?.especialidades && reg.especialidades.length > 0 && (
                        <div className="text-xs text-slate-500">
                          {reg.especialidades.join(", ")}
                          {reg.modalidad ? ` · ${reg.modalidad}` : ""}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <span
                        className={`inline-block rounded-full px-2 py-0.5 text-xs ${stateClass}`}
                      >
                        {t.candidate_state}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-700">
                      {postCount.get(t.tecnico_id) ?? 0}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-700">
                      {asignadoCount.get(t.tecnico_id) ?? 0}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-700">
                      {firmadoCount.get(t.tecnico_id) ?? 0}
                    </td>
                    <td className="px-3 py-2 text-xs text-slate-500">
                      {dec ? (
                        <>
                          <div className="text-slate-700">
                            → {dec.to_state ?? "?"}
                          </div>
                          <div>
                            {new Date(dec.at).toLocaleString("es-CO")} ·{" "}
                            {dec.actor ?? "—"}
                          </div>
                        </>
                      ) : (
                        <span className="text-slate-400">sin decisiones</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
