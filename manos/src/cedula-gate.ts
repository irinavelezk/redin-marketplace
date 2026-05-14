// Pre-LLM cédula verification gate for Manos.
//
// Flow:
//   1. If session.meta.arq_row_id already set → pass through (gate already open).
//   2. Check the current message + recent history for a cédula pattern (6–12 digits).
//   3. If cédula found → ilike-match against arquitectos_mirror.data->>'Cedula'.
//      - Match: set session.meta.arq_row_id, persist meta, log manos_cedula_verified,
//               return "perfecto, listo <nombre>".
//      - No match: log manos_cedula_rejected, escalate to Telegram, return polite refusal.
//   4. No cédula in messages yet → return onboarding prompt.
//
// Identity is in the tool input layer too (arq_row_id validation) — this gate
// is the first line of defense at the session boundary.

import { createLogger } from "@redin/shared";
import type { ServerClient } from "@redin/shared";
import type { TelegramEscalationSink } from "./telegram-escalation";

const log = createLogger("manos:cedula-gate");

// Cédula pattern: 6–12 consecutive digits (Colombian cédulas are 6–10 digits;
// we allow up to 12 for edge cases and NIT-like codes).
const CEDULA_RE = /\b(\d{6,12})\b/;

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
  // Session meta is read/written directly so the gate can persist arq_row_id.
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
  if (typeof ctx.sessionMeta.arq_row_id === "string" && ctx.sessionMeta.arq_row_id.trim()) {
    return { passed: true };
  }

  // Look for a cédula in the current message.
  const match = CEDULA_RE.exec(ctx.currentText);
  if (!match) {
    // No cédula yet — send onboarding prompt.
    return {
      passed: false,
      reply:
        "Hola, soy Manos, el asistente de Redin para arquitectos. Para empezar, mándame tu cédula, por favor.",
    };
  }

  const cedula = match[1]!;
  log.info("cédula candidate", { phone: ctx.phone, cedula: cedula.slice(0, 4) + "****" });

  // Query arquitectos_mirror for this cédula (case-insensitive).
  const { data: rows, error } = await ctx.supabase
    .from("arquitectos_mirror")
    .select("row_id, data")
    .filter("data->>Cedula", "ilike", cedula)
    .limit(5);

  if (error) {
    log.error("cedula lookup failed", { error: error.message, phone: ctx.phone });
    return {
      passed: false,
      reply: "Tuve un error al verificar tu cédula. Inténtalo de nuevo en un momento.",
    };
  }

  // Accept first exact match (case-insensitive).
  const matched = (rows ?? []).find((r) => {
    const d = r.data as Record<string, unknown>;
    return String(d["Cedula"] ?? "").toLowerCase() === cedula.toLowerCase();
  });

  if (!matched) {
    // Log rejection and escalate.
    await ctx.supabase.from("eventos").insert({
      type: "manos_cedula_rejected",
      entity_id: null,
      actor: `arquitecto:${ctx.phone}`,
      meta: { cedula_prefix: cedula.slice(0, 4), phone: ctx.phone },
    });

    await ctx.escalationSink?.send(
      `Manos: cédula no encontrada en arquitectos_mirror — phone=${ctx.phone} cedula=${cedula.slice(0, 4)}****`
    );

    log.warn("cedula not found", { phone: ctx.phone });
    return {
      passed: false,
      reply:
        "No encontré esa cédula en nuestro directorio de arquitectos. Verifica el número o habla con el equipo de Redin para que te agreguen.",
    };
  }

  // Successful verification — pull display name.
  const data = matched.data as Record<string, unknown>;
  const nombre =
    typeof data["Nombre"] === "string" && data["Nombre"].trim()
      ? data["Nombre"].trim()
      : typeof data["Nombre de Arquitecto"] === "string" && data["Nombre de Arquitecto"].trim()
        ? (data["Nombre de Arquitecto"] as string).trim()
        : "arquitecto";

  // Persist arq_row_id to session meta.
  ctx.sessionMeta.arq_row_id = matched.row_id;
  await ctx.supabase
    .from("sessions")
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .update({ meta: ctx.sessionMeta as any })
    .eq("id", ctx.sessionId);

  // Log event.
  await ctx.supabase.from("eventos").insert({
    type: "manos_cedula_verified",
    entity_id: matched.row_id,
    actor: `arquitecto:${ctx.phone}`,
    meta: { arq_row_id: matched.row_id, nombre, phone: ctx.phone },
  });

  log.info("cedula verified", { phone: ctx.phone, arq_row_id: matched.row_id });

  return {
    passed: true,
    reply: `Perfecto, ¡listo ${nombre}! ¿Con qué OT empezamos?`,
  };
}
