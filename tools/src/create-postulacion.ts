// create_postulacion — a técnico applies to an OT.
// Unique constraint on (ot_id, tecnico_id) — if duplicate, we return the existing
// row with state=already_applied. Writes `postulacion_created` event.

import type { Json } from "@redin/shared";
import type { ToolContext } from "./context";
import { recordEvent } from "./events";
import { INPUT_CAPS } from "./schemas";
import type {
  CreatePostulacionInput,
  CreatePostulacionOutput,
  ToolResult,
} from "./types";
import { err, ok } from "./types";

function descripcionFrom(data: Json): string {
  if (!data || typeof data !== "object" || Array.isArray(data)) return "";
  const d = data as Record<string, unknown>;
  for (const k of ["Descripcion", "descripcion", "Resumen Visual", "Actividad_Descripcion"]) {
    const v = d[k];
    if (typeof v === "string" && v.trim().length > 0) return v.trim();
  }
  return "";
}

export async function createPostulacion(
  ctx: ToolContext,
  input: CreatePostulacionInput
): Promise<ToolResult<CreatePostulacionOutput>> {
  if (!input.ot_id?.trim()) return err("ot_id required", { code: "invalid_input" });
  if (!input.tecnico_id?.trim()) return err("tecnico_id required", { code: "invalid_input" });
  if (input.mensaje != null && input.mensaje.length > INPUT_CAPS.mensaje) {
    return err(`mensaje exceeds ${INPUT_CAPS.mensaje} characters`, { code: "input_too_long" });
  }

  // Confirm the OT exists in our mirror; pull enough fields to summarize it
  // back to the worker without a separate read_pending_ots call.
  const { data: ot, error: otErr } = await ctx.supabase
    .from("ots_mirror")
    .select("row_id, ciudad, especialidad, estado, data")
    .eq("row_id", input.ot_id)
    .maybeSingle();
  if (otErr) {
    return err(`db error: ${otErr.message}`, { code: "db_error", retryable: true });
  }
  if (!ot) return err("ot_id not found in ots_mirror", { code: "not_found" });
  const otSummary = {
    ciudad: ot.ciudad,
    especialidad: ot.especialidad,
    descripcion: descripcionFrom(ot.data as Json),
    estado: ot.estado,
  };

  // Confirm the técnico exists, is active, and has cleared HR qualification.
  // Migration 007 renamed qualification_state -> candidate_state and the
  // 7-state machine. Postulaciones gate on candidate_state='approved' (the
  // new vocabulary equivalent of the old 'qualified'). Workers in screening /
  // pending / needs_call see a hold message via the prompt; rejected /
  // withdrawn / revoked are also blocked here.
  const { data: tec, error: tecErr } = await ctx.supabase
    .from("tecnicos_extended")
    .select("tecnico_id,estado,candidate_state")
    .eq("tecnico_id", input.tecnico_id)
    .maybeSingle();
  if (tecErr) {
    return err(`db error: ${tecErr.message}`, { code: "db_error", retryable: true });
  }
  if (!tec) return err("tecnico_id not found", { code: "not_found" });
  if (tec.estado !== "activo") {
    return err(`tecnico is ${tec.estado}, cannot apply`, { code: "tecnico_inactive" });
  }
  if (tec.candidate_state !== "approved") {
    return err(
      `candidate state is ${tec.candidate_state}; cannot apply until HR approves`,
      { code: "qualification_pending" }
    );
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
        return ok({
          postulacion_id: existing.id,
          state: "already_applied",
          ot: otSummary,
        });
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

  return ok({
    postulacion_id: inserted.id,
    state: "postulado",
    ot: otSummary,
  });
}
