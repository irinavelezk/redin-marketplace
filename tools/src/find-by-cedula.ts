// find_by_cedula — pure read on tecnicos_extended.cedula (UNIQUE partial index).
// Lets Toño recognize a returning worker on a new phone (decision 6: cedula is
// the only worker identity, phones are disposable).
//
// Auth-free. No write. The agent calls this AFTER capturing a cedula, BEFORE
// submit_candidate_dossier. If the result is `found:true`, the agent should
// branch on candidate_state per the contract:
//   approved   -> "ya estás aprobado" + nothing
//   pending    -> "ya estás registrado, en cola" + escalate if asked
//   needs_call -> tell worker HR will call
//   rejected   -> escalate_to_hr (no auto-reopen)
//   withdrawn  -> resume; submit_candidate_dossier merges
//   revoked    -> escalate_to_hr (terminal)
//   screening  -> mid-flow on different phone; merge happens at submission

import type { ToolContext } from "./context";
import { ok, err, type ToolResult } from "./types";
import type {
  FindByCedulaInput,
  FindByCedulaOutput,
} from "@redin/shared/dossier-types";

function normalizeCedula(raw: string): string {
  return raw.replace(/[^\d]/g, "");
}

export async function findByCedula(
  ctx: ToolContext,
  input: FindByCedulaInput
): Promise<ToolResult<FindByCedulaOutput>> {
  const cedula = normalizeCedula(input.cedula ?? "");
  if (!cedula) {
    return err("cedula required (digits)", { code: "invalid_input" });
  }
  if (cedula.length < 5 || cedula.length > 11) {
    return err("cedula must be 5-11 digits", { code: "invalid_input" });
  }

  const { data, error } = await ctx.supabase
    .from("tecnicos_extended")
    .select("tecnico_id, candidate_state, phone")
    .eq("cedula", cedula)
    .maybeSingle();
  if (error) {
    ctx.logger.error("find_by_cedula query failed", {
      cedula_masked: maskCedula(cedula),
      error: error.message,
    });
    return err(`db error: ${error.message}`, {
      code: "db_error",
      retryable: true,
    });
  }

  if (!data) return ok({ found: false });

  // Pull display name from the same priority chain identify_user uses:
  // legacy bootstrap -> registered -> mirror.
  const nombre = await loadNombre(ctx, data.tecnico_id);

  return ok({
    found: true,
    tecnico_id: data.tecnico_id,
    candidate_state: data.candidate_state as FindByCedulaOutput["candidate_state"],
    last_phone: data.phone,
    nombre: nombre ?? undefined,
  });
}

async function loadNombre(
  ctx: ToolContext,
  tecnicoId: string
): Promise<string | null> {
  // Priority 1: legacy bootstrap event
  const { data: legacy } = await ctx.supabase
    .from("eventos")
    .select("meta")
    .eq("type", "tecnico_legacy_bootstrap")
    .eq("entity_id", tecnicoId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const fromMeta = (m: unknown): string | null => {
    if (m && typeof m === "object" && !Array.isArray(m)) {
      const obj = m as Record<string, unknown>;
      if (typeof obj.nombre === "string" && obj.nombre.trim().length > 0) {
        return obj.nombre.trim();
      }
    }
    return null;
  };
  const fromLegacy = fromMeta(legacy?.meta);
  if (fromLegacy) return fromLegacy;

  // Priority 2: tecnico_registered event
  const { data: reg } = await ctx.supabase
    .from("eventos")
    .select("meta")
    .eq("type", "tecnico_registered")
    .eq("entity_id", tecnicoId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const fromReg = fromMeta(reg?.meta);
  if (fromReg) return fromReg;

  // Priority 3: tecnicos_mirror (warm imports)
  const { data: mirror } = await ctx.supabase
    .from("tecnicos_mirror")
    .select("data")
    .eq("row_id", tecnicoId)
    .maybeSingle();
  if (mirror?.data && typeof mirror.data === "object" && !Array.isArray(mirror.data)) {
    const m = mirror.data as Record<string, unknown>;
    const cand =
      m["Nombre de Tecnico"] ?? m["Nombre"] ?? m["nombre"] ?? m["NOMBRE"];
    if (typeof cand === "string" && cand.trim().length > 0) {
      return cand.trim();
    }
  }
  return null;
}

function maskCedula(c: string): string {
  if (c.length <= 4) return "****";
  return `${c.slice(0, 2)}${"*".repeat(c.length - 4)}${c.slice(-2)}`;
}
