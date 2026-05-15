// set_alcance_ot — writes structured alcance (scope) to ots_extended
// and sets appsheet_alcance_pending=true to trigger the projector outbox.
//
// Identity gate: arq_row_id injected from session.meta via agent dispatcher.
// Ownership check: validates ots_mirror.data->>'Arquitecto_Asignado' = arq_row_id.

import type { ToolContext } from "../context";
import type { ToolResult } from "../types";
import { ok, err } from "../types";
import { verifyOtOwnership } from "./attach-photos";

// Alcance shape — validated at runtime; stored as JSONB in ots_extended.
export interface AlcanceShape {
  especialidad: string;
  subcategoria?: string;
  cantidades?: string[];
  conditions?: string[];
  schedule_notes?: string;
  value_estimate?: string;
  summary: string;
}

export interface SetAlcanceOtInput {
  arq_row_id: string;
  ot_row_id: string;
  alcance: AlcanceShape;
}

export interface SetAlcanceOtOutput {
  ot_row_id: string;
  alcance_saved: boolean;
  appsheet_pending: boolean;
}

export async function setAlcanceOt(
  ctx: ToolContext,
  args: Record<string, unknown>
): Promise<ToolResult<SetAlcanceOtOutput>> {
  const arqRowId = typeof args.arq_row_id === "string" ? args.arq_row_id.trim() : "";
  const otRowId = typeof args.ot_row_id === "string" ? args.ot_row_id.trim() : "";
  const alcanceRaw = args.alcance as Record<string, unknown> | undefined;

  if (!arqRowId) {
    return err("arq_row_id required — cédula not verified", {
      code: "no_identity",
      missing: ["arq_row_id"],
    });
  }
  if (!otRowId) {
    return err("ot_row_id required", { code: "missing_field", missing: ["ot_row_id"] });
  }

  // Validate alcance shape minimally.
  if (!alcanceRaw || typeof alcanceRaw !== "object") {
    return err("alcance is required and must be an object", {
      code: "missing_field",
      missing: ["alcance"],
    });
  }
  const especialidad =
    typeof alcanceRaw.especialidad === "string" ? alcanceRaw.especialidad.trim() : "";
  const summary =
    typeof alcanceRaw.summary === "string" ? alcanceRaw.summary.trim() : "";
  if (!especialidad) {
    return err("alcance.especialidad is required", {
      code: "missing_field",
      missing: ["alcance.especialidad"],
      user_message_hint: "¿Cuál es la especialidad principal de este trabajo? (ej. Eléctrico, Pintura, etc.)",
    });
  }
  if (!summary) {
    return err("alcance.summary is required", {
      code: "missing_field",
      missing: ["alcance.summary"],
      user_message_hint: "Necesito un resumen del alcance para guardarlo.",
    });
  }

  // Ownership check.
  const ownershipErr = await verifyOtOwnership(ctx, otRowId, arqRowId);
  if (ownershipErr) return ownershipErr;

  // Build clean alcance object.
  const alcance: AlcanceShape = {
    especialidad,
    summary,
    ...(typeof alcanceRaw.subcategoria === "string" && alcanceRaw.subcategoria
      ? { subcategoria: alcanceRaw.subcategoria }
      : {}),
    ...(Array.isArray(alcanceRaw.cantidades)
      ? { cantidades: (alcanceRaw.cantidades as unknown[]).map(String) }
      : {}),
    ...(Array.isArray(alcanceRaw.conditions)
      ? { conditions: (alcanceRaw.conditions as unknown[]).map(String) }
      : {}),
    ...(typeof alcanceRaw.schedule_notes === "string" && alcanceRaw.schedule_notes
      ? { schedule_notes: alcanceRaw.schedule_notes }
      : {}),
    ...(typeof alcanceRaw.value_estimate === "string" && alcanceRaw.value_estimate
      ? { value_estimate: alcanceRaw.value_estimate }
      : {}),
  };

  // Upsert ots_extended with alcance_jsonb + appsheet_alcance_pending=true.
  const upsertPayload = {
    ot_row_id: otRowId,
    alcance_jsonb: alcance as unknown,
    last_architect_arq_row_id: arqRowId,
    appsheet_alcance_pending: true,
    appsheet_alcance_sync_attempts: 0,
    updated_at: new Date().toISOString(),
  };
  const { error: upsertErr } = await ctx.supabase
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .from("ots_extended")
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .upsert(upsertPayload as any, { onConflict: "ot_row_id" });

  if (upsertErr) {
    return err(`ots_extended upsert failed: ${upsertErr.message}`, { code: "db_error" });
  }

  // Log event.
  await ctx.supabase.from("eventos").insert({
    type: "alcance_started",
    entity_id: otRowId,
    actor: `arquitecto:${arqRowId}`,
    meta: {
      ot_row_id: otRowId,
      arq_row_id: arqRowId,
      especialidad,
      summary: summary.slice(0, 200),
    },
  });

  return ok({
    ot_row_id: otRowId,
    alcance_saved: true,
    appsheet_pending: true,
  });
}
