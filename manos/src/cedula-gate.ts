// Pre-LLM cédula verification gate for Manos.
//
// Flow:
//   1. If session.meta.arq_row_id already set → pass through (gate already open).
//   2. Extract a cédula candidate from the current message — accepts any common
//      Colombian format (digits only, dotted "1.098.665.432", spaced, comma-separated).
//   3. Normalize candidate and stored cédula to digits-only, compare.
//      - Match: set session.meta.arq_row_id, persist meta, log manos_cedula_verified,
//               return "perfecto, listo <nombre>".
//      - No match: log manos_cedula_rejected, escalate to Telegram, return polite refusal.
//   4. No cédula in messages yet → return onboarding prompt.
//
// AppSheet `Arquitecto` schema (verified live 2026-05-14):
//   Row ID, Arquitecto (display name), Cedula, Email, Telefono, Related Ordenes_Trabajos.
//   Cedula is typed as text — may arrive digits-only or with thousand separators.

import { createLogger } from "@redin/shared";
import type { ServerClient } from "@redin/shared";
import type { TelegramEscalationSink } from "./telegram-escalation";

const log = createLogger("manos:cedula-gate");

/** Strip every non-digit character. */
function digitsOnly(s: string): string {
  return s.replace(/\D/g, "");
}

/**
 * Extract a cédula candidate from free-text. Accepts:
 *   - 1098665432
 *   - 1.098.665.432
 *   - 1,098,665,432
 *   - 1 098 665 432
 *   - "mi cédula es 1.098.665.432, gracias"
 *
 * Strategy: iterate every sequence of digit-or-separator characters, normalize
 * to digits-only, return the first one whose length lands in the cédula range.
 */
function extractCedula(text: string): string | null {
  const re = /\d[\d.,\s]*\d|\d/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const digits = digitsOnly(m[0]);
    if (digits.length >= 6 && digits.length <= 12) {
      return digits;
    }
  }
  return null;
}

export interface CedulaGateResult {
  /** true = gate is open, LLM should proceed. */
  passed: boolean;
  /** Reply to send to architect if gate is not yet open or verification failed. */
  reply?: string;
}

export interface CedulaGateContext {
  supabase: ServerClient;
  phone: string;
  currentText: string;
  sessionId: string;
  sessionMeta: Record<string, unknown>;
  escalationSink?: TelegramEscalationSink;
}

/**
 * Run the cédula gate.
 * Mutates ctx.sessionMeta.arq_row_id on successful verification and persists
 * it to the sessions table.
 */
export async function runCedulaGate(
  ctx: CedulaGateContext
): Promise<CedulaGateResult> {
  // Gate already open — architect verified in this session.
  if (
    typeof ctx.sessionMeta.arq_row_id === "string" &&
    ctx.sessionMeta.arq_row_id.trim()
  ) {
    return { passed: true };
  }

  const cedulaDigits = extractCedula(ctx.currentText);
  if (!cedulaDigits) {
    return {
      passed: false,
      reply:
        "Hola, soy Manos, el asistente de Redin para arquitectos. Para empezar, mándame tu cédula, por favor.",
    };
  }

  log.info("cédula candidate", {
    phone: ctx.phone,
    cedula_prefix: cedulaDigits.slice(0, 4) + "****",
    cedula_len: cedulaDigits.length,
  });

  // Pull all architect rows (small set, ~10) and compare digit-normalized cédulas.
  // Done in-memory instead of SQL because the stored cédula can have arbitrary
  // separator chars (dots/commas/spaces) and a generic regexp_replace in SQL would
  // complicate the query without speed benefit at this row count.
  const { data: rows, error } = await ctx.supabase
    .from("arquitectos_mirror")
    .select("row_id, data");

  if (error) {
    log.error("cedula lookup failed", { error: error.message, phone: ctx.phone });
    return {
      passed: false,
      reply: "Tuve un error al verificar tu cédula. Inténtalo de nuevo en un momento.",
    };
  }

  const matched = (rows ?? []).find((r) => {
    const d = r.data as Record<string, unknown>;
    const stored = String(d["Cedula"] ?? "");
    if (!stored) return false;
    return digitsOnly(stored) === cedulaDigits;
  });

  if (!matched) {
    await ctx.supabase.from("eventos").insert({
      type: "manos_cedula_rejected",
      entity_id: null,
      actor: `arquitecto:${ctx.phone}`,
      meta: {
        cedula_prefix: cedulaDigits.slice(0, 4),
        cedula_len: cedulaDigits.length,
        phone: ctx.phone,
      },
    });

    await ctx.escalationSink?.send(
      `Manos: cédula no encontrada en arquitectos_mirror — phone=${ctx.phone} cedula=${cedulaDigits.slice(0, 4)}****`
    );

    log.warn("cedula not found", { phone: ctx.phone, cedula_len: cedulaDigits.length });
    return {
      passed: false,
      reply:
        "No encontré esa cédula en nuestro directorio de arquitectos. Verifica el número o habla con el equipo de Redin para que te agreguen.",
    };
  }

  // Successful verification — resolve display name.
  // AppSheet column is `Arquitecto`. Fallbacks for legacy/manual data.
  const data = matched.data as Record<string, unknown>;
  const nombre =
    pickString(data, ["Arquitecto", "Nombre", "Nombre de Arquitecto", "Name"]) ??
    "arquitecto";

  ctx.sessionMeta.arq_row_id = matched.row_id;
  await ctx.supabase
    .from("sessions")
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .update({ meta: ctx.sessionMeta as any })
    .eq("id", ctx.sessionId);

  await ctx.supabase.from("eventos").insert({
    type: "manos_cedula_verified",
    entity_id: matched.row_id,
    actor: `arquitecto:${ctx.phone}`,
    meta: { arq_row_id: matched.row_id, nombre, phone: ctx.phone },
  });

  log.info("cedula verified", {
    phone: ctx.phone,
    arq_row_id: matched.row_id,
    nombre,
  });

  return {
    passed: true,
    reply: `Perfecto, ¡listo ${nombre}! ¿Con qué OT empezamos?`,
  };
}

function pickString(d: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = d[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}
