// list_my_pending_ots — returns ALL state-4 OTs with rich context for the model
// to match against whatever the architect mentions (ID, _RowNumber, ciudad,
// descripcion, cliente). Each item is tagged `is_yours` (ID_Arquitecto match)
// and `has_alcance` so the model knows when it's safe to write.
//
// Identity gate: arq_row_id must be present (injected by manos/agent from
// session.meta after the cédula gate sets it). Tool refuses if absent.
//
// AppSheet `Ordenes_Trabajo` columns relevant here (verified live 2026-05-15):
//   Row ID, _RowNumber, Numero_Orden, ID_Orden, Ciudad, Estado, Categoria,
//   Subcategoria, Descripcion, Resumen Visual, Valor_Estimado,
//   ID_Arquitecto (← FK to arquitectos_mirror.row_id),
//   Nombre_Arquitecto_Real (← display name for the assigned architect),
//   Alcance_OT (← Manos writes here via the reverse-projector).
//
// IMPORTANT: `Arquitecto_Asignado` was the wrong key (Stream A draft). Real key
// is `ID_Arquitecto`. Confirmed by inspect-ot-relations.mjs on live mirror.

import type { ToolContext } from "../context";
import type { ToolResult } from "../types";
import { ok, err } from "../types";

const OFFERABLE_ESTADO = "4. Coordinar – Listo para ejecutar";
const CAP = 20;

export interface ListMyPendingOtsInput {
  arq_row_id: string;
}

export interface PendingOtItem {
  ot_row_id: string;
  row_number: string | null;
  numero_orden: string | null;
  id_orden: string | null;
  ciudad: string | null;
  especialidad: string | null;
  subcategoria: string | null;
  descripcion: string;
  resumen_visual: string | null;
  valor_estimado: string | null;
  estado: string | null;
  nombre_arquitecto: string | null;
  is_yours: boolean;
  has_alcance: boolean;
}

export interface ListMyPendingOtsOutput {
  ots: PendingOtItem[];
  total: number;
  yours_count: number;
  yours_without_alcance_count: number;
}

function pickString(d: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = d[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
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

  const { data: otsRows, error: otsErr } = await ctx.supabase
    .from("ots_mirror")
    .select("row_id, ciudad, especialidad, estado, data")
    .eq("estado", OFFERABLE_ESTADO)
    .limit(CAP);

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
  const allRows = (otsRows ?? []) as LocalOtRow[];
  if (allRows.length === 0) {
    return ok({ ots: [], total: 0, yours_count: 0, yours_without_alcance_count: 0 });
  }

  // Cross-reference ots_extended for explicit alcance state (Manos-written).
  const rowIds = allRows.map((r) => r.row_id);
  const { data: extRows } = await ctx.supabase
    .from("ots_extended")
    .select("ot_row_id, alcance_jsonb")
    .in("ot_row_id", rowIds);

  interface ExtRow {
    ot_row_id: string;
    alcance_jsonb: unknown;
  }
  const extAlcanceByRowId = new Map<string, boolean>();
  for (const ext of (extRows ?? []) as ExtRow[]) {
    extAlcanceByRowId.set(ext.ot_row_id, ext.alcance_jsonb !== null);
  }

  const result: PendingOtItem[] = allRows.map((row) => {
    const d = (row.data ?? {}) as Record<string, unknown>;
    const idArq = String(d["ID_Arquitecto"] ?? "").trim();
    const isYours = idArq === arqRowId;

    // has_alcance is true if EITHER:
    //   (a) ots_extended row has alcance_jsonb (Manos-written, structured)
    //   (b) ots_mirror.data.Alcance_OT has any non-empty content (AppSheet-side text)
    const appsheetAlcance = String(d["Alcance_OT"] ?? "").trim();
    const hasAlcance =
      extAlcanceByRowId.get(row.row_id) === true || appsheetAlcance.length > 0;

    const descripcion =
      pickString(d, ["Descripcion", "descripcion"]) ??
      pickString(d, ["Resumen Visual"]) ??
      "(sin descripción)";

    return {
      ot_row_id: row.row_id,
      row_number: pickString(d, ["_RowNumber"]),
      numero_orden: pickString(d, ["Numero_Orden", "numero_orden"]),
      id_orden: pickString(d, ["ID_Orden", "id_orden"]),
      ciudad: row.ciudad,
      especialidad: row.especialidad,
      subcategoria: pickString(d, ["Subcategoria", "subcategoria"]),
      descripcion: descripcion.slice(0, 300),
      resumen_visual: pickString(d, ["Resumen Visual"])?.slice(0, 200) ?? null,
      valor_estimado: pickString(d, ["Valor_Estimado", "valor_estimado"]),
      estado: row.estado,
      nombre_arquitecto: pickString(d, ["Nombre_Arquitecto_Real", "Nombre_Arquitecto"]),
      is_yours: isYours,
      has_alcance: hasAlcance,
    };
  });

  const yoursCount = result.filter((r) => r.is_yours).length;
  const yoursWithoutAlcance = result.filter((r) => r.is_yours && !r.has_alcance).length;

  return ok({
    ots: result,
    total: result.length,
    yours_count: yoursCount,
    yours_without_alcance_count: yoursWithoutAlcance,
  });
}
