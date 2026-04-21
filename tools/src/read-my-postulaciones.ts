// read_my_postulaciones — all postulaciones for a técnico, each joined with OT data.
// Used by "¿En qué van mis aplicaciones?" in WA and by the técnico dashboard.

import type { Json } from "@redin/shared";
import type { ToolContext } from "./context";
import type {
  PostulacionSummary,
  ReadMyPostulacionesInput,
  ReadMyPostulacionesOutput,
  ToolResult,
} from "./types";
import { err, ok } from "./types";

function descripcionFrom(data: Json | null): string {
  if (!data || typeof data !== "object" || Array.isArray(data)) return "";
  const d = data as Record<string, unknown>;
  const candidates = ["Descripcion", "descripcion", "Resumen Visual", "Actividad_Descripcion"];
  for (const k of candidates) {
    const v = d[k];
    if (typeof v === "string" && v.trim().length > 0) return v.trim();
  }
  return "";
}

export async function readMyPostulaciones(
  ctx: ToolContext,
  input: ReadMyPostulacionesInput
): Promise<ToolResult<ReadMyPostulacionesOutput>> {
  if (!input.tecnico_id?.trim()) {
    return err("tecnico_id required", { code: "invalid_input" });
  }
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);

  const { data: posts, error } = await ctx.supabase
    .from("postulaciones")
    .select("*")
    .eq("tecnico_id", input.tecnico_id)
    .order("applied_at", { ascending: false })
    .limit(limit);
  if (error) {
    return err(`db error: ${error.message}`, { code: "db_error", retryable: true });
  }
  if (!posts || posts.length === 0) return ok({ postulaciones: [] });

  const otIds = [...new Set(posts.map((p) => p.ot_id))];
  const { data: ots, error: otErr } = await ctx.supabase
    .from("ots_mirror")
    .select("*")
    .in("row_id", otIds);
  if (otErr) {
    return err(`db error: ${otErr.message}`, { code: "db_error", retryable: true });
  }
  const otById = new Map(ots?.map((o) => [o.row_id, o]) ?? []);

  const out: PostulacionSummary[] = posts.map((p) => {
    const ot = otById.get(p.ot_id);
    return {
      postulacion: p,
      ot: ot
        ? {
            ot_id: ot.row_id,
            ciudad: ot.ciudad,
            especialidad: ot.especialidad,
            estado: ot.estado,
            descripcion: descripcionFrom(ot.data),
          }
        : null,
    };
  });

  return ok({ postulaciones: out });
}
