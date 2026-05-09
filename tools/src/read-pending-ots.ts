// read_pending_ots — list OTs currently offerable to a worker, optionally
// filtered by ciudad / especialidad / técnico profile match.
//
// Only OTs in state "4. Coordinar – Listo para ejecutar" are offerable. Earlier
// states aren't ready for a worker to take; later states are already in motion
// or closed. The literal must match AppSheet exactly (em-dash, "4." prefix).

import type { Json } from "@redin/shared";
import type { ToolContext } from "./context";
import type {
  PendingOtSummary,
  ReadPendingOtsInput,
  ReadPendingOtsOutput,
  ToolResult,
} from "./types";
import { err, ok } from "./types";

// Exported so the dashboard pipeline view (and, eventually, the AppSheet
// sync Selector) can use the same canonical literal — single source of
// truth for "the only assignable OT state".
export const OFFERABLE_ESTADO = "4. Coordinar – Listo para ejecutar";

function descripcionFrom(data: Json): string {
  if (!data || typeof data !== "object" || Array.isArray(data)) return "";
  const d = data as Record<string, unknown>;
  const candidates = ["Descripcion", "descripcion", "Resumen Visual", "Actividad_Descripcion"];
  for (const k of candidates) {
    const v = d[k];
    if (typeof v === "string" && v.trim().length > 0) return v.trim();
  }
  return "";
}

function valorEstimadoFrom(data: Json): { num: number | null; label: string | null } {
  if (!data || typeof data !== "object" || Array.isArray(data)) return { num: null, label: null };
  const raw = (data as Record<string, unknown>).Valor_Estimado;
  if (typeof raw !== "string") return { num: null, label: null };
  const num = Number.parseFloat(raw.replace(/[^\d.-]/g, ""));
  if (!Number.isFinite(num) || num <= 0) return { num: null, label: null };
  const label = new Intl.NumberFormat("es-CO", {
    style: "currency",
    currency: "COP",
    maximumFractionDigits: 0,
  }).format(num);
  return { num, label };
}

function fechaProgramadaFrom(data: Json): string | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const raw = (data as Record<string, unknown>).Fecha_Programada;
  if (typeof raw !== "string" || !raw.trim()) return null;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("es-CO", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

export async function readPendingOts(
  ctx: ToolContext,
  input: ReadPendingOtsInput
): Promise<ToolResult<ReadPendingOtsOutput>> {
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 100);

  // tecnico_id is informational: it confirms the worker exists and lets the
  // agent describe results as personalized via `matched_by_profile`. We do NOT
  // auto-derive ciudad / especialidad from the worker's profile here — the
  // agent has that profile from identify_user and is responsible for passing
  // the filters it actually wants applied.
  let matchedByProfile = false;
  if (input.tecnico_id) {
    const { data: tec, error: tecErr } = await ctx.supabase
      .from("tecnicos_extended")
      .select("tecnico_id")
      .eq("tecnico_id", input.tecnico_id)
      .maybeSingle();
    if (tecErr) {
      return err(`db error: ${tecErr.message}`, { code: "db_error", retryable: true });
    }
    if (!tec) {
      return err("tecnico_id not found", { code: "not_found" });
    }
    matchedByProfile = true;
  }

  const ciudadFilter = input.ciudad?.trim();
  const especialidadFilter = input.especialidad?.trim();

  const { data: rawOts, error } = await ctx.supabase
    .from("ots_mirror")
    .select("*")
    .eq("estado", OFFERABLE_ESTADO)
    .order("synced_at", { ascending: false })
    .limit(limit);

  if (error) {
    return err(`db error: ${error.message}`, { code: "db_error", retryable: true });
  }

  // Application-side filters for ciudad / especialidad — PostgREST struggles
  // with accents (Bogotá, plomería) and we want substring/normalized match.
  const normalize = (s: string) =>
    s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const ciudadNorm = ciudadFilter ? normalize(ciudadFilter) : null;
  const especNorm = especialidadFilter ? normalize(especialidadFilter) : null;
  const ots = (rawOts ?? []).filter((o) => {
    if (ciudadNorm && !normalize(o.ciudad ?? "").includes(ciudadNorm)) return false;
    if (especNorm && !normalize(o.especialidad ?? "").includes(especNorm)) return false;
    return true;
  });

  if (ots.length === 0) {
    return ok({ ots: [], matched_by_profile: matchedByProfile });
  }

  // Pull postulacion counts in a single query.
  const otIds = ots.map((o) => o.row_id);
  const { data: counts, error: countErr } = await ctx.supabase
    .from("postulaciones")
    .select("ot_id,state")
    .in("ot_id", otIds);
  if (countErr) {
    return err(`db error: ${countErr.message}`, { code: "db_error", retryable: true });
  }
  const totalByOt = new Map<string, number>();
  const shortlistByOt = new Map<string, number>();
  for (const row of counts ?? []) {
    totalByOt.set(row.ot_id, (totalByOt.get(row.ot_id) ?? 0) + 1);
    if (row.state === "preseleccionado" || row.state === "asignado") {
      shortlistByOt.set(row.ot_id, (shortlistByOt.get(row.ot_id) ?? 0) + 1);
    }
  }

  const out: PendingOtSummary[] = ots.map((o) => {
    const data = o.data as Json;
    let createdAt: string | null = null;
    if (data && typeof data === "object" && !Array.isArray(data)) {
      const d = data as Record<string, unknown>;
      const fc = d["Fecha_Creacion"];
      if (typeof fc === "string") createdAt = fc;
    }
    const valor = valorEstimadoFrom(data);
    return {
      ot_id: o.row_id,
      ciudad: o.ciudad,
      especialidad: o.especialidad,
      estado: o.estado,
      descripcion: descripcionFrom(o.data),
      postulacion_count: totalByOt.get(o.row_id) ?? 0,
      shortlist_count: shortlistByOt.get(o.row_id) ?? 0,
      created_at: createdAt,
      valor_estimado: valor.num,
      valor_estimado_label: valor.label,
      fecha_programada: fechaProgramadaFrom(data),
    };
  });

  return ok({ ots: out, matched_by_profile: matchedByProfile });
}
