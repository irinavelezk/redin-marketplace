// attach_photos — appends photo URLs to an OT's ots_extended row.
//
// Identity gate: arq_row_id injected from session.meta via agent dispatcher.
// Ownership check: validates that ots_mirror.data->>'ID_Arquitecto' = arq_row_id.

import type { ToolContext } from "../context";
import type { ToolResult } from "../types";
import { ok, err } from "../types";

export interface AttachPhotosInput {
  arq_row_id: string;
  ot_row_id: string;
  photo_urls: string[];
}

export interface AttachPhotosOutput {
  ot_row_id: string;
  total_photos: number;
}

export async function attachPhotos(
  ctx: ToolContext,
  args: Record<string, unknown>
): Promise<ToolResult<AttachPhotosOutput>> {
  const arqRowId = typeof args.arq_row_id === "string" ? args.arq_row_id.trim() : "";
  const otRowId = typeof args.ot_row_id === "string" ? args.ot_row_id.trim() : "";
  const photoUrls = Array.isArray(args.photo_urls)
    ? (args.photo_urls as unknown[]).filter((u): u is string => typeof u === "string")
    : [];

  if (!arqRowId) {
    return err("arq_row_id required — cédula not verified", {
      code: "no_identity",
      missing: ["arq_row_id"],
    });
  }
  if (!otRowId) {
    return err("ot_row_id required", { code: "missing_field", missing: ["ot_row_id"] });
  }
  if (photoUrls.length === 0) {
    return err("photo_urls must contain at least one URL", {
      code: "missing_field",
      missing: ["photo_urls"],
    });
  }

  // Ownership check.
  const ownershipErr = await verifyOtOwnership(ctx, otRowId, arqRowId);
  if (ownershipErr) return ownershipErr;

  // Upsert ots_extended row and append photo_paths.
  const { data: existing } = await ctx.supabase
    .from("ots_extended")
    .select("photo_paths")
    .eq("ot_row_id", otRowId)
    .maybeSingle();

  const currentPaths: string[] = Array.isArray(existing?.photo_paths)
    ? (existing.photo_paths as string[])
    : [];
  const updatedPaths = [...currentPaths, ...photoUrls];

  const attachPayload = {
    ot_row_id: otRowId,
    photo_paths: updatedPaths,
    last_architect_arq_row_id: arqRowId,
    updated_at: new Date().toISOString(),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error: upsertErr } = await ctx.supabase
    .from("ots_extended")
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .upsert(attachPayload as any, { onConflict: "ot_row_id" });

  if (upsertErr) {
    return err(`ots_extended upsert failed: ${upsertErr.message}`, { code: "db_error" });
  }

  // Log event.
  await ctx.supabase.from("eventos").insert({
    type: "alcance_photo_attached",
    entity_id: otRowId,
    actor: `arquitecto:${arqRowId}`,
    meta: { ot_row_id: otRowId, arq_row_id: arqRowId, photo_count: photoUrls.length },
  });

  return ok({ ot_row_id: otRowId, total_photos: updatedPaths.length });
}

// Shared ownership verifier — used by all 3 write tools.
export async function verifyOtOwnership(
  ctx: ToolContext,
  otRowId: string,
  arqRowId: string
): Promise<ToolResult<never> | null> {
  const { data: otRow, error } = await ctx.supabase
    .from("ots_mirror")
    .select("row_id, estado, data")
    .eq("row_id", otRowId)
    .maybeSingle();

  if (error) {
    return err(`ots_mirror query failed: ${error.message}`, { code: "db_error" });
  }
  if (!otRow) {
    return err("OT not found", {
      code: "not_found",
      user_message_hint: "Esa OT no existe en el sistema.",
    });
  }

  const d = otRow.data as Record<string, unknown>;
  // AppSheet `Ordenes_Trabajo` column for the assigned architect is `ID_Arquitecto`
  // (foreign key to arquitectos_mirror.row_id). `Arquitecto_Asignado` is a
  // separate (and in practice empty) AppSheet field; do not rely on it.
  const idArq = String(d["ID_Arquitecto"] ?? "").trim();
  if (idArq !== arqRowId) {
    const realName = typeof d["Nombre_Arquitecto_Real"] === "string"
      ? (d["Nombre_Arquitecto_Real"] as string).trim()
      : "";
    const hint = realName
      ? `Esa OT está asignada a ${realName}, no a ti — no puedo editar el alcance.`
      : "Esa OT no está asignada a ti — no puedo editar el alcance.";
    return err("OT is not assigned to this architect", {
      code: "not_your_ot",
      user_message_hint: hint,
    });
  }

  return null; // ownership verified
}
