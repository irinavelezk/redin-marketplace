// create_postulacion — a técnico applies to an OT.
// Unique constraint on (ot_id, tecnico_id) — if duplicate, we return the existing
// row with state=already_applied. Writes `postulacion_created` event.

import type { ToolContext } from "./context";
import { recordEvent } from "./events";
import type {
  CreatePostulacionInput,
  CreatePostulacionOutput,
  ToolResult,
} from "./types";
import { err, ok } from "./types";

export async function createPostulacion(
  ctx: ToolContext,
  input: CreatePostulacionInput
): Promise<ToolResult<CreatePostulacionOutput>> {
  if (!input.ot_id?.trim()) return err("ot_id required", { code: "invalid_input" });
  if (!input.tecnico_id?.trim()) return err("tecnico_id required", { code: "invalid_input" });

  // Confirm the OT exists in our mirror.
  const { data: ot, error: otErr } = await ctx.supabase
    .from("ots_mirror")
    .select("row_id,estado")
    .eq("row_id", input.ot_id)
    .maybeSingle();
  if (otErr) {
    return err(`db error: ${otErr.message}`, { code: "db_error", retryable: true });
  }
  if (!ot) return err("ot_id not found in ots_mirror", { code: "not_found" });

  // Confirm the técnico exists.
  const { data: tec, error: tecErr } = await ctx.supabase
    .from("tecnicos_extended")
    .select("tecnico_id,estado")
    .eq("tecnico_id", input.tecnico_id)
    .maybeSingle();
  if (tecErr) {
    return err(`db error: ${tecErr.message}`, { code: "db_error", retryable: true });
  }
  if (!tec) return err("tecnico_id not found", { code: "not_found" });
  if (tec.estado !== "activo") {
    return err(`tecnico is ${tec.estado}, cannot apply`, { code: "tecnico_inactive" });
  }

  const { data: inserted, error: insertErr } = await ctx.supabase
    .from("postulaciones")
    .insert({
      ot_id: input.ot_id,
      tecnico_id: input.tecnico_id,
      mensaje: input.mensaje ?? null,
    })
    .select("id")
    .single();

  if (insertErr) {
    if (insertErr.code === "23505") {
      const { data: existing } = await ctx.supabase
        .from("postulaciones")
        .select("id")
        .eq("ot_id", input.ot_id)
        .eq("tecnico_id", input.tecnico_id)
        .maybeSingle();
      if (existing) {
        return ok({ postulacion_id: existing.id, state: "already_applied" });
      }
    }
    return err(`insert failed: ${insertErr.message}`, {
      code: "db_error",
      retryable: true,
    });
  }

  await recordEvent(ctx, {
    type: "postulacion_created",
    entity_id: inserted.id,
    actor: input.actor ?? ctx.defaultActor,
    meta: {
      ot_id: input.ot_id,
      tecnico_id: input.tecnico_id,
      mensaje: input.mensaje ?? null,
    },
  });

  return ok({ postulacion_id: inserted.id, state: "postulado" });
}
