// list_my_pending_ots — returns OTs assigned to this architect
// that are in state "4. Coordinar – Listo para ejecutar" AND have no alcance yet.
//
// Identity gate: arq_row_id must be present in args (injected by manos agent
// from session.meta). Tool refuses with ToolError if absent.

import type { ToolContext } from "../context";
import type { ToolResult } from "../types";
import { ok, err } from "../types";

const OFFERABLE_ESTADO = "4. Coordinar – Listo para ejecutar";
const CAP = 10;

export interface ListMyPendingOtsInput {
  arq_row_id: string;
}

export interface PendingOtItem {
  ot_row_id: string;
  descripcion: string;
  ciudad: string | null;
  especialidad: string | null;
  estado: string | null;
  alcance_present: boolean;
}

export interface ListMyPendingOtsOutput {
  ots: PendingOtItem[];
  total: number;
}

export async function listMyPendingOts(
  ctx: ToolContext,
  args: Record<string, unknown>
): Promise<ToolResult<ListMyPendingOtsOutput>> {
  const arqRowId = typeof args.arq_row_id === "string" ? args.arq_row_id.trim() : "";
  if (!arqRowId) {
    return err("arq_row_id is required — cédula not yet verified in this session", {
      code: "no_identity",
      next_action: "ask_cedula",
      missing: ["arq_row_id"],
      user_message_hint: "Mándame tu cédula para que pueda verificar tu identidad.",
    });
  }

  // Fetch ots_mirror rows where Arquitecto_Asignado = arq_row_id AND estado = offerable.
  const { data: otsRows, error: otsErr } = await ctx.supabase
    .from("ots_mirror")
    .select("row_id, ciudad, especialidad, estado, data")
    .eq("estado", OFFERABLE_ESTADO)
    .limit(CAP * 3); // Fetch more to filter by Arquitecto_Asignado in JS

  if (otsErr) {
    return err(`ots_mirror query failed: ${otsErr.message}`, { code: "db_error" });
  }

  interface LocalOtRow {
    row_id: string;
    ciudad: string | null;
    especialidad: string | null;
    estado: string | null;
    data: Record<string, unknown> | null;
  }

  // Filter by Arquitecto_Asignado field inside the JSONB data.
  const allRows = (otsRows ?? []) as LocalOtRow[];
  const assignedOts = allRows.filter((row) => {
    const d = (row.data ?? {}) as Record<string, unknown>;
    const asignado = d["Arquitecto_Asignado"] ?? d["arquitecto_asignado"] ?? d["Row ID del Arquitecto"];
    return String(asignado ?? "") === arqRowId;
  });

  if (assignedOts.length === 0) {
    return ok({ ots: [], total: 0 });
  }

  // Fetch ots_extended to check which already have alcance.
  const assignedRowIds = assignedOts.map((r) => r.row_id);
  const { data: extRows } = await ctx.supabase
    .from("ots_extended")
    .select("ot_row_id, alcance_jsonb")
    .in("ot_row_id", assignedRowIds.slice(0, CAP * 3));

  interface ExtRow { ot_row_id: string; alcance_jsonb: unknown }
  const extByRowId = new Map<string, boolean>();
  for (const ext of (extRows ?? []) as ExtRow[]) {
    extByRowId.set(ext.ot_row_id, ext.alcance_jsonb !== null);
  }

  // Only include OTs without alcance.
  const withoutAlcance = assignedOts.filter((r) => !extByRowId.get(r.row_id));

  const result = withoutAlcance.slice(0, CAP).map((row) => {
    const d = (row.data ?? {}) as Record<string, unknown>;
    const descripcion =
      (typeof d["Descripcion"] === "string" ? d["Descripcion"] : null) ??
      (typeof d["descripcion"] === "string" ? d["descripcion"] : null) ??
      (typeof d["Resumen Visual"] === "string" ? d["Resumen Visual"] : null) ??
      "(sin descripción)";
    return {
      ot_row_id: row.row_id,
      descripcion: descripcion.slice(0, 300),
      ciudad: row.ciudad,
      especialidad: row.especialidad,
      estado: row.estado,
      alcance_present: false,
    };
  });

  return ok({ ots: result, total: result.length });
}
