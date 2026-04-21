// register_tecnico — create (or fetch-if-exists) a tecnicos_extended row.
// Idempotent on phone: re-registering with same phone returns the existing row
// and merges new data where safe. Writes `tecnico_registered` event on new create.

import { normalizePhone, type Json } from "@redin/shared";
import { randomUUID } from "node:crypto";
import type { ToolContext } from "./context";
import { recordEvent } from "./events";
import { INPUT_CAPS } from "./schemas";
import type {
  RegisterTecnicoInput,
  RegisterTecnicoOutput,
  ToolResult,
} from "./types";
import { err, ok } from "./types";

// Accept synonyms from the LLM ("solo" from the system prompt; "individual" from the schema).
// Normalize to canonical set before we store.
const MODALIDAD_ALIASES: Record<string, "individual" | "cuadrilla" | "lider"> = {
  individual: "individual",
  solo: "individual",
  cuadrilla: "cuadrilla",
  lider: "lider",
  líder: "lider",
};

export async function registerTecnico(
  ctx: ToolContext,
  input: RegisterTecnicoInput
): Promise<ToolResult<RegisterTecnicoOutput>> {
  const phone = normalizePhone(input.phone);
  if (!phone) return err("phone is required", { code: "invalid_input" });
  if (!input.nombre?.trim()) return err("nombre is required", { code: "invalid_input" });
  if (input.nombre.length > INPUT_CAPS.nombre) {
    return err(`nombre exceeds ${INPUT_CAPS.nombre} characters`, { code: "input_too_long" });
  }
  if (!input.ciudad?.trim()) return err("ciudad is required", { code: "invalid_input" });
  if (!Array.isArray(input.especialidades) || input.especialidades.length === 0) {
    return err("especialidades must be a non-empty array", { code: "invalid_input" });
  }
  const canonical =
    MODALIDAD_ALIASES[(input.modalidad as string | undefined)?.toLowerCase() ?? ""];
  if (!canonical) {
    return err(
      `modalidad must be one of: individual/solo, cuadrilla, lider`,
      { code: "invalid_input" }
    );
  }
  const modalidad = canonical;
  const liderPhone = input.lider_phone ? normalizePhone(input.lider_phone) : null;

  // Fast-path: does this phone already have a row?
  const { data: existing, error: lookupErr } = await ctx.supabase
    .from("tecnicos_extended")
    .select("*")
    .eq("phone", phone)
    .maybeSingle();
  if (lookupErr) {
    return err(`db error: ${lookupErr.message}`, { code: "db_error", retryable: true });
  }

  if (existing) {
    // Update non-destructive fields if the caller provided new ones.
    const patch: Partial<typeof existing> = {};
    if (liderPhone && existing.lider_phone !== liderPhone) patch.lider_phone = liderPhone;
    if (input.source && !existing.source) patch.source = input.source;
    if (Object.keys(patch).length > 0) {
      const { error: updateErr } = await ctx.supabase
        .from("tecnicos_extended")
        .update(patch)
        .eq("tecnico_id", existing.tecnico_id);
      if (updateErr) {
        return err(`update failed: ${updateErr.message}`, {
          code: "db_error",
          retryable: true,
        });
      }
    }
    await recordEvent(ctx, {
      type: "tecnico_re_registered",
      entity_id: existing.tecnico_id,
      actor: input.actor ?? ctx.defaultActor,
      meta: {
        phone,
        nombre: input.nombre,
        ciudad: input.ciudad,
        especialidades: input.especialidades,
        modalidad,
      },
    });
    return ok({ tecnico_id: existing.tecnico_id, created: false });
  }

  // Fresh insert. We own the id: uuid (not an AppSheet row_id — that gets
  // reconciled by the sync worker if/when this phone appears in Jose's table).
  const tecnicoId = randomUUID();
  const { error: insertErr } = await ctx.supabase.from("tecnicos_extended").insert({
    tecnico_id: tecnicoId,
    phone,
    lider_phone: liderPhone,
    estado: "activo",
    source: input.source ?? "dashboard",
  });
  if (insertErr) {
    // Race — another concurrent register arrived first. Retry the lookup.
    if (insertErr.code === "23505") {
      const { data: retry } = await ctx.supabase
        .from("tecnicos_extended")
        .select("*")
        .eq("phone", phone)
        .maybeSingle();
      if (retry) return ok({ tecnico_id: retry.tecnico_id, created: false });
    }
    return err(`insert failed: ${insertErr.message}`, {
      code: "db_error",
      retryable: true,
    });
  }

  await recordEvent(ctx, {
    type: "tecnico_registered",
    entity_id: tecnicoId,
    actor: input.actor ?? ctx.defaultActor,
    meta: {
      phone,
      nombre: input.nombre,
      ciudad: input.ciudad,
      especialidades: input.especialidades,
      modalidad,
      lider_phone: liderPhone,
      source: input.source ?? "dashboard",
    } satisfies Record<string, Json>,
  });

  return ok({ tecnico_id: tecnicoId, created: true });
}
