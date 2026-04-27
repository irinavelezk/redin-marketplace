// read_pending_ots — list OTs currently in the marketplace queue, optionally
// filtered by ciudad / especialidad / técnico profile match.
//
// "Pending" = estado NOT in terminal states. We treat anything that's not
// Facturado/Pagado/Terminado/Cancelada as a candidate for marketplace broadcast.
// The agent gets the full list so it can re-filter and describe.

import type { Json } from "@redin/shared";
import type { ToolContext } from "./context";
import type {
  PendingOtSummary,
  ReadPendingOtsInput,
  ReadPendingOtsOutput,
  ToolResult,
} from "./types";
import { err, ok } from "./types";

// Treat these as "closed" — do NOT surface to the marketplace.
const TERMINAL_ESTADOS = [
  "Terminado",
  "Facturado",
  "Pagado",
  "99. Perdida / Cancelada",
];

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
    .order("synced_at", { ascending: false })
    .limit(limit);

  if (error) {
    return err(`db error: ${error.message}`, { code: "db_error", retryable: true });
  }

  // Strict filter — exactly what the agent requested. Application-side because
  // PostgREST struggles with accents in filter values (Bogotá, plomería) and
  // multi-word terminal estados. normalize() strips accents so "plomeria"
  // matches "plomería" and "Bogota" matches "Bogotá".
  const normalize = (s: string) =>
    s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const ciudadNorm = ciudadFilter ? normalize(ciudadFilter) : null;
  const especNorm = especialidadFilter ? normalize(especialidadFilter) : null;
  const ots = (rawOts ?? []).filter((o) => {
    if (TERMINAL_ESTADOS.includes(o.estado ?? "")) return false;
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
    return {
      ot_id: o.row_id,
      ciudad: o.ciudad,
      especialidad: o.especialidad,
      estado: o.estado,
      descripcion: descripcionFrom(o.data),
      postulacion_count: totalByOt.get(o.row_id) ?? 0,
      shortlist_count: shortlistByOt.get(o.row_id) ?? 0,
      created_at: createdAt,
    };
  });

  return ok({ ots: out, matched_by_profile: matchedByProfile });
}
