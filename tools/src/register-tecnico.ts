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

// Identity gate (Phase 0a). The tool refuses to write a partial-identity
// row; on rejection it tells the agent what to ask next via the
// next_action / missing / user_message_hint envelope. This replaces the
// soft re-ask prompt prose that conversation momentum kept steamrolling.
//
// Validation policy:
//   - nombre must split into ≥2 whitespace-separated tokens (first name +
//     at least one apellido). The handler does NOT try to parse first vs.
//     paterno vs. materno — it just enforces "more than a single token."
//   - contact_phone must be present and look like a Colombian phone after
//     stripping spaces and dashes: 10 digits, OR optional "+" / 57 prefix
//     followed by 10 digits. We are validating SHAPE, not deliverability.
function validateIdentity(input: {
  nombre: string;
  contact_phone?: string | null;
}):
  | { ok: true; nombre: string; contact_phone: string }
  | {
      ok: false;
      error: "INCOMPLETE_IDENTITY";
      next_action: "ask_apellidos" | "ask_contact_phone";
      missing: ("apellidos" | "contact_phone")[];
      user_message_hint: string;
    } {
  const nombre = (input.nombre ?? "").trim();
  const tokens = nombre.split(/\s+/).filter(Boolean);
  const hasFullName = tokens.length >= 2;

  const contactRaw = (input.contact_phone ?? "").toString().trim();
  const contactNorm = contactRaw.replace(/[\s\-()]/g, "");
  const contactShapeOk =
    /^\+?57\d{10}$/.test(contactNorm) || /^\d{10}$/.test(contactNorm);

  const missing: ("apellidos" | "contact_phone")[] = [];
  if (!hasFullName) missing.push("apellidos");
  if (!contactNorm || !contactShapeOk) missing.push("contact_phone");

  if (missing.length === 0) {
    return { ok: true, nombre, contact_phone: contactNorm };
  }

  // Ask serially. Apellidos first (it's the most natural follow-up to
  // "¿cómo te llamas?" and mirrors how a person would respond).
  if (!hasFullName) {
    return {
      ok: false,
      error: "INCOMPLETE_IDENTITY",
      next_action: "ask_apellidos",
      missing,
      user_message_hint: "Pásame tu nombre completo, con los dos apellidos.",
    };
  }
  // hasFullName === true here; missing must be contact_phone.
  if (contactNorm && !contactShapeOk) {
    return {
      ok: false,
      error: "INCOMPLETE_IDENTITY",
      next_action: "ask_contact_phone",
      missing,
      user_message_hint:
        "Ese número no parece colombiano. Pásame uno de 10 dígitos, por ejemplo 313 202 2941.",
    };
  }
  return {
    ok: false,
    error: "INCOMPLETE_IDENTITY",
    next_action: "ask_contact_phone",
    missing,
    user_message_hint:
      "Dame un número donde te podamos llamar (puede ser el mismo de WhatsApp o uno distinto).",
  };
}

export async function registerTecnico(
  ctx: ToolContext,
  input: RegisterTecnicoInput
): Promise<ToolResult<RegisterTecnicoOutput>> {
  const phone = normalizePhone(input.phone);
  if (!phone) return err("phone is required", { code: "invalid_input" });
  if (!input.ciudad?.trim()) return err("ciudad is required", { code: "invalid_input" });
  if (!Array.isArray(input.especialidades) || input.especialidades.length === 0) {
    return err("especialidades must be a non-empty array", { code: "invalid_input" });
  }
  // Identity gate — see validateIdentity above. The handler refuses to
  // write a row that doesn't carry both a multi-token nombre AND a
  // shape-valid contact_phone, and tells the agent which one to ask for.
  const idCheck = validateIdentity({
    nombre: input.nombre,
    contact_phone: input.contact_phone,
  });
  if (!idCheck.ok) {
    return err(idCheck.error, {
      code: "INCOMPLETE_IDENTITY",
      next_action: idCheck.next_action,
      missing: idCheck.missing,
      user_message_hint: idCheck.user_message_hint,
    });
  }
  const { nombre, contact_phone } = idCheck;
  if (nombre.length > INPUT_CAPS.nombre) {
    return err(`nombre exceeds ${INPUT_CAPS.nombre} characters`, { code: "input_too_long" });
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
    // Migration 010: lazily backfill `nombre` on the row if we never wrote it.
    // Don't overwrite an existing nombre — re-registration may receive a
    // shorter answer than what's already on file.
    if (!existing.nombre && nombre) patch.nombre = nombre;
    // Migration 011: lazily backfill contact_phone the same way. Both fields
    // are write-once: registration never overwrites HR-validated data.
    if (!existing.contact_phone && contact_phone) patch.contact_phone = contact_phone;
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
        nombre,
        ciudad: input.ciudad,
        especialidades: input.especialidades,
        modalidad,
        contact_phone,
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
    nombre,
    contact_phone,
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
      nombre,
      ciudad: input.ciudad,
      especialidades: input.especialidades,
      modalidad,
      lider_phone: liderPhone,
      contact_phone,
      source: input.source ?? "dashboard",
    } satisfies Record<string, Json>,
  });

  return ok({ tecnico_id: tecnicoId, created: true });
}
