// Pre-LLM branch for customer rating replies and customer-contact hand-offs.
//
// Flow: when sync-mp detects an OT flipping to "Terminado" it enqueues a
// WhatsApp from Toño asking the customer for stars + an optional comment.
// When the customer replies, we don't want to run their reply through Toño's
// system prompt (which is built around técnico interactions) — that risks
// regressing the worker happy path. Instead, intercept here:
//
//   1. Collision rule — WORKER > CUSTOMER. If the inbound phone is also in
//      tecnicos_extended, treat as worker and return handled=false immediately.
//   2. If the inbound phone has a recent customer_rating_request outbound
//      AND we haven't already recorded a rating for that ot_id, treat the
//      message as a rating reply: parse stars + notes, write to `ratings`,
//      send a canned ack.
//   3. NEW (Story 18): If the phone is a known contact in contactos_mirror
//      BUT has no pending rating request, send a canned polite hand-off and
//      log customer_contact_intent_attempt. Never falls through to Toño's
//      worker tool set.
//   4. Otherwise return handled=false and let agent.ts continue normal flow.
//
// Edge cases:
//   - Reply has no digit 1-5 → send retry, don't dedup; same handler fires
//     again on the next reply.
//   - Customer replies again after a successful rating → falls through to
//     normal flow (Toño will respond conversationally, no tools available
//     since they're not a registered técnico).

import { createLogger, type ServerClient } from "@redin/shared";

const log = createLogger("tono:customer-ratings");

// Window for matching an inbound reply to an outstanding rating request.
const REQUEST_WINDOW_HOURS = 72;
// Cap on free-text comment length to keep the row small.
const NOTES_MAX = 500;

// Canned hand-off for customer contacts with no pending rating.
// Story 18: spec §6 "Stream B — Toño quality (Stories 17 + 18)".
const CUSTOMER_CONTACT_HANDOFF =
  "Hola, gracias por escribir. Este número es para técnicos buscando " +
  "trabajo con Redin, y para clientes calificando un servicio terminado. " +
  "¿Quieres calificar el trabajo de un técnico? Si necesitas otra cosa, " +
  "Jose Luis (tu contacto en Redin) puede ayudarte.";

export interface CustomerRatingResult {
  handled: boolean;
  reply?: string;
}

interface PendingRequest {
  outbound_id: string;
  ot_id: string;
  tecnico_id: string | null;
  created_at: string;
}

export async function tryHandleCustomerRatingReply(
  supabase: ServerClient,
  phone: string,
  text: string
): Promise<CustomerRatingResult> {
  // Collision rule: if the phone belongs to a registered worker, treat as
  // worker — do NOT short-circuit. Workers take precedence over customer contacts.
  const { data: workerRow } = await supabase
    .from("tecnicos_extended")
    .select("tecnico_id")
    .eq("phone", phone)
    .maybeSingle();
  if (workerRow) {
    return { handled: false };
  }

  const request = await loadOutstandingRequest(supabase, phone);

  if (!request) {
    // Check if the phone is a known customer contact (contactos_mirror).
    // If so, short-circuit with the hand-off message — never reaches worker tools.
    const { data: contactRow } = await supabase
      .from("contactos_mirror")
      .select("row_id")
      .eq("telefono", phone)
      .maybeSingle();
    if (contactRow) {
      log.info("customer contact intent attempt — sending hand-off", { phone });
      await supabase.from("eventos").insert({
        type: "customer_contact_intent_attempt",
        entity_id: null,
        actor: `customer:${phone}`,
        meta: { phone, inbound_text: text },
      });
      return { handled: true, reply: CUSTOMER_CONTACT_HANDOFF };
    }
    return { handled: false };
  }

  const { stars, notes } = parseRatingText(text);
  if (stars === null) {
    log.info("customer rating: reply had no digit, prompting retry", {
      phone,
      ot_id: request.ot_id,
    });
    return {
      handled: true,
      reply:
        "No alcancé a entender la calificación. ¿Puedes responderme con un número del 1 al 5? (1 = mal, 5 = excelente)",
    };
  }

  // Idempotency guard: if a rating already exists for (ot_id, rater=phone),
  // don't duplicate it — fall through to normal flow.
  const { count: existing } = await supabase
    .from("ratings")
    .select("id", { count: "exact", head: true })
    .eq("ot_id", request.ot_id)
    .eq("rater", phone);
  if ((existing ?? 0) > 0) {
    log.info("customer rating: already rated, falling through", {
      phone,
      ot_id: request.ot_id,
    });
    return { handled: false };
  }

  const ratee = request.tecnico_id ?? "unknown";
  const { error: insertErr } = await supabase.from("ratings").insert({
    ot_id: request.ot_id,
    rater: phone,
    ratee,
    stars,
    notes: notes && notes.length > 0 ? notes : null,
  });
  if (insertErr) {
    log.error("customer rating: ratings insert failed", {
      phone,
      ot_id: request.ot_id,
      error: insertErr.message,
    });
    // Don't block the customer's reply — let it fall through so they aren't
    // stuck. They'll get Toño's generic flow which is at least a response.
    return { handled: false };
  }

  await supabase.from("eventos").insert({
    type: "customer_rating_received",
    entity_id: request.ot_id,
    actor: `customer:${phone}`,
    meta: {
      stars,
      notes: notes ?? null,
      tecnico_id: request.tecnico_id,
      outbound_id: request.outbound_id,
    },
  });

  log.info("customer rating: recorded", {
    phone,
    ot_id: request.ot_id,
    tecnico_id: request.tecnico_id,
    stars,
    has_notes: !!notes,
  });

  return {
    handled: true,
    reply:
      stars >= 4
        ? "¡Gracias por calificar! Nos ayuda mucho saber que el trabajo quedó bien."
        : "Gracias por la calificación. Tu opinión nos ayuda a mejorar — el equipo de Redin la revisa.",
  };
}

async function loadOutstandingRequest(
  supabase: ServerClient,
  phone: string
): Promise<PendingRequest | null> {
  const sinceIso = new Date(
    Date.now() - REQUEST_WINDOW_HOURS * 60 * 60 * 1000
  ).toISOString();
  const { data: rows, error } = await supabase
    .from("outbound_messages")
    .select("id, meta, created_at")
    .eq("phone", phone)
    .gt("created_at", sinceIso)
    .order("created_at", { ascending: false })
    .limit(20);
  if (error) {
    log.error("customer rating: outbound query failed", {
      phone,
      error: error.message,
    });
    return null;
  }
  for (const row of rows ?? []) {
    const meta = row.meta;
    if (!meta || typeof meta !== "object" || Array.isArray(meta)) continue;
    const m = meta as Record<string, unknown>;
    if (m.type !== "customer_rating_request") continue;
    const otId = typeof m.ot_id === "string" ? m.ot_id : null;
    if (!otId) continue;
    const tecnicoId = typeof m.tecnico_id === "string" ? m.tecnico_id : null;
    return {
      outbound_id: row.id,
      ot_id: otId,
      tecnico_id: tecnicoId,
      created_at: row.created_at,
    };
  }
  return null;
}

export function parseRatingText(text: string): {
  stars: number | null;
  notes: string | null;
} {
  const trimmed = text.trim();
  if (!trimmed) return { stars: null, notes: null };
  const match = trimmed.match(/[1-5]/);
  if (!match) return { stars: null, notes: null };
  const stars = Number.parseInt(match[0], 10);
  // Strip the matched digit + adjacent star/punctuation noise from notes.
  const beforeIdx = match.index ?? 0;
  const before = trimmed.slice(0, beforeIdx);
  const after = trimmed.slice(beforeIdx + 1);
  const notesRaw = `${before}${after}`
    .replace(/\b(estrella|estrellas|stars?|de\s*5|\/\s*5)\b/gi, "")
    .replace(/[*★⭐]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const notes = notesRaw.length > 0 ? notesRaw.slice(0, NOTES_MAX) : null;
  return { stars, notes };
}
