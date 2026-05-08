// find_by_cedula — pure read on tecnicos_extended.cedula (UNIQUE partial index).
// Lets Toño recognize a returning worker on a new phone (decision 6: cedula is
// the only worker identity, phones are disposable).
//
// Auth-free. No write. The agent calls this AFTER capturing a cedula, BEFORE
// submit_candidate_dossier. The output carries a `next_action` directive that
// the agent MUST obey (per the prompt's REGLA ABSOLUTA on tool-driven
// branching) — see the FindByCedulaNextAction docstring for the full mapping.

import type { ToolContext } from "./context";
import { ok, err, type ToolResult } from "./types";
import type {
  CandidateState,
  FindByCedulaInput,
  FindByCedulaNextAction,
  FindByCedulaOutput,
} from "@redin/shared/dossier-types";

const STATE_TO_NEXT_ACTION: Record<
  CandidateState,
  { next_action: FindByCedulaNextAction; suggested_reply: string }
> = {
  screening: {
    next_action: "resume_screening",
    suggested_reply: "Bienvenido de vuelta, sigamos donde quedamos.",
  },
  withdrawn: {
    next_action: "resume_screening",
    suggested_reply: "Bienvenido de vuelta, sigamos donde quedamos.",
  },
  pending: {
    next_action: "tell_user_already_in_queue",
    suggested_reply: "Ya estamos validando tu perfil, te avisamos pronto.",
  },
  needs_call: {
    next_action: "tell_user_team_will_call",
    suggested_reply: "El equipo va a llamarte pronto, mantente atento.",
  },
  approved: {
    next_action: "tell_user_already_approved",
    suggested_reply: "Ya estás registrado y aprobado con Redin.",
  },
  rejected: {
    next_action: "tell_user_was_rejected",
    suggested_reply: "Hubo una decisión previa; te conecto con el equipo.",
  },
  revoked: {
    next_action: "tell_user_was_rejected",
    suggested_reply: "Hubo una decisión previa; te conecto con el equipo.",
  },
};

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

  if (!data) {
    // Cedula not in tecnicos_extended. Two possibilities the agent must
    // resolve before resuming screening:
    //   1. cold worker (real not-found)
    //   2. legacy worker contacting from a new phone — their tecnicos_extended
    //      row exists with cedula=NULL, so cedula lookup misses. The legacy
    //      bootstrap event has the name; find_legacy_by_name finds it.
    // Encoded as a two-step next_action: the agent MUST call
    // find_legacy_by_name next; that tool's own next_action will tell the
    // agent whether to escalate (similarity hit) or proceed (no match).
    return ok({
      found: false,
      next_action: "check_legacy_name_then_proceed",
      suggested_reply:
        "Cédula nueva. Antes de seguir, déjame confirmar el nombre con find_legacy_by_name.",
    });
  }

  // Pull display name from the same priority chain identify_user uses:
  // legacy bootstrap -> registered -> mirror.
  const nombre = await loadNombre(ctx, data.tecnico_id);

  const state = data.candidate_state as CandidateState;
  const branch = STATE_TO_NEXT_ACTION[state];

  return ok({
    found: true,
    tecnico_id: data.tecnico_id,
    candidate_state: state,
    last_phone: data.phone,
    nombre: nombre ?? undefined,
    next_action: branch.next_action,
    suggested_reply: branch.suggested_reply,
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
