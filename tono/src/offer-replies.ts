// Pre-LLM branch for HR-triggered job-offer replies.
//
// Flow: HR clicks "Enviar oferta" on the shortlist UI. The system inserts an
// `ot_offers` row in state='sent' and queues a WhatsApp text + alcance PDF to
// the worker. The worker replies on WhatsApp with "acepto", "paso", or some
// variant. We intercept that reply BEFORE the LLM so the response is
// deterministic and zero-cost:
//
//   1. Pattern-match the inbound text against accept/reject regexes anchored
//      on the first ~30 chars. If neither matches → return handled=false and
//      let Toño respond conversationally.
//   2. Resolve the inbound phone to a tecnico_id via tecnicos_extended (phone
//      first, contact_phone fallback). No worker row → handled=false (could
//      be an unregistered customer, the LLM will deal with it).
//   3. Find the latest open (state='sent', now() < expires_at) ot_offers row
//      for that tecnico. No open offer → handled=false (they said "acepto"
//      without a pending offer; let the LLM respond naturally).
//   4. Flip the offer to 'accepted' or 'rejected', stamp responded_at +
//      response_text.
//   5. On accept: upsert a postulaciones row in state='preseleccionado' so
//      the existing /hr/shortlist "Generar contrato" flow takes over unchanged.
//   6. Log an `eventos` row (offer_accepted | offer_rejected) for audit.
//   7. Ping HR via Telegram (best-effort; swallow errors).
//   8. Return { handled: true, reply } with a worker-facing confirmation.
//
// Architectural mirror of customer-ratings.ts — same return shape, same
// fail-open discipline (any DB error → handled=false, fall through to LLM).
//
// Edge cases:
//   - Worker replies "acepto" twice: the second time, the active offer is no
//     longer in state='sent' (we flipped it on the first reply), so the
//     latest-open-offer query returns nothing → handled=false. The LLM then
//     answers conversationally. Idempotent by construction; no double upsert
//     of postulaciones.
//   - Reply lands 73h after offer (just past expiry): the partial index on
//     ot_offers excludes rows past expires_at via `now() < expires_at` in
//     the WHERE clause → handled=false → LLM handles it. (A separate cron
//     is responsible for sweeping `state='sent'` past expires_at to
//     'expired'; this handler doesn't need to do that work.)

import { createLogger, type ServerClient } from "@redin/shared";

const log = createLogger("tono:offer-replies");

// First ~30 chars matter; we don't want to match "acepto" buried inside a
// long sentence that means something else.
const PREFIX_WINDOW = 30;

// Anchored on a normalized prefix. Order matters when patterns overlap
// ("no acepto" must hit reject before accept's "acepto" alternative — but
// since accept is anchored at start-of-string and the reject regex includes
// "no acepto" explicitly, we test reject FIRST to be safe).
const ACCEPT_RE =
  /^(acepto|aceptado|si\b|s[ií]\b|claro|listo|dale|ok\b|de acuerdo|me interesa|s[ií] acepto|yo acepto|quiero|si quiero|s[ií] quiero)/i;
const REJECT_RE =
  /^(paso|no\b|rechaz|no puedo|no me interesa|otro d[ií]a|esta vez no|no acepto|no gracias)/i;

export type OfferReplyResult =
  | { handled: false }
  | { handled: true; reply: string };

export interface OfferReplyContext {
  phone: string;
  text: string;
  supabase: ServerClient;
  telegram: { send(text: string): Promise<void> } | null;
  log: (level: "info" | "warn" | "error", msg: string, meta?: unknown) => void;
}

interface OpenOffer {
  id: string;
  ot_row_id: string;
  tecnico_id: string;
  state: string;
  sent_at: string;
  expires_at: string;
}

export async function tryMatchOfferReply(
  ctx: OfferReplyContext
): Promise<OfferReplyResult> {
  // 1. Classify intent.
  const intent = classifyIntent(ctx.text);
  if (intent === "none") return { handled: false };

  try {
    // 2. Resolve tecnico_id. Try phone first (WA identity), then contact_phone
    // (the callable number — separate per migration 011).
    const worker = await loadWorker(ctx.supabase, ctx.phone);
    if (!worker) return { handled: false };

    // 3. Find the latest open offer. The query enforces the 72h window via
    // `now() < expires_at` so we don't need a JS-side check.
    const offer = await loadOpenOffer(ctx.supabase, worker.tecnico_id);
    if (!offer) return { handled: false };

    // 4. Flip the offer's state.
    // NOTE: cast to `any` — db-types.ts hasn't been regenerated to include
    // ot_offers (migration 014). Same pattern as dashboard/offer-actions.ts.
    // TODO: drop the cast after types regenerate.
    const newState = intent === "accept" ? "accepted" : "rejected";
    const { error: updErr } = await (ctx.supabase as any)
      .from("ot_offers")
      .update({
        state: newState,
        responded_at: new Date().toISOString(),
        response_text: ctx.text.slice(0, 1000),
      })
      .eq("id", offer.id)
      .eq("state", "sent"); // optimistic guard against races
    if (updErr) {
      ctx.log("error", "offer-reply: ot_offers update failed", {
        offer_id: offer.id,
        error: updErr.message,
      });
      return { handled: false };
    }

    // 5. Load OT ciudad for messaging (best-effort; missing is non-fatal).
    const ciudad = await loadOtCiudad(ctx.supabase, offer.ot_row_id);

    // 6. On accept: upsert postulaciones in 'preseleccionado' so the existing
    // /hr/shortlist "Generar contrato" flow takes over with no changes.
    //
    // Schema note (migrations/001_init.sql:35-45): postulaciones.tecnico_id
    // is `text` (not uuid), and the unique is on (ot_id, tecnico_id). Passing
    // the uuid string from ot_offers works for both columns.
    if (intent === "accept") {
      const { error: upErr } = await ctx.supabase.from("postulaciones").upsert(
        {
          ot_id: offer.ot_row_id,
          tecnico_id: offer.tecnico_id,
          state: "preseleccionado",
          mensaje: "accepted_offer",
          applied_at: new Date().toISOString(),
          decided_by: "system:offer_accepted",
          decided_at: new Date().toISOString(),
        },
        { onConflict: "ot_id,tecnico_id" }
      );
      if (upErr) {
        // Don't bail — the offer is already flipped and HR will still see it.
        // Log loud so we notice if this regresses.
        ctx.log("error", "offer-reply: postulaciones upsert failed", {
          offer_id: offer.id,
          ot_row_id: offer.ot_row_id,
          tecnico_id: offer.tecnico_id,
          error: upErr.message,
        });
      }
    }

    // 7. Audit event.
    await ctx.supabase
      .from("eventos")
      .insert({
        type: intent === "accept" ? "offer_accepted" : "offer_rejected",
        entity_id: offer.ot_row_id,
        actor: `tecnico:${ctx.phone}`,
        meta: {
          ot_offer_id: offer.id,
          tecnico_id: offer.tecnico_id,
          response_text: ctx.text.slice(0, 1000),
        },
      })
      .then(({ error }) => {
        if (error) {
          ctx.log("warn", "offer-reply: eventos insert failed (non-fatal)", {
            error: error.message,
          });
        }
      });

    // 8. Best-effort HR ping. Telegram errors are swallowed by the sink.
    if (ctx.telegram) {
      const shortOt = offer.ot_row_id.slice(0, 8);
      const ciudadStr = ciudad ?? "ciudad sin registrar";
      const tgText =
        intent === "accept"
          ? `✅ ${worker.nombre} ACEPTÓ la oferta para OT ${shortOt} en ${ciudadStr}. Revisa /hr/shortlist/${offer.ot_row_id} para generar el contrato.`
          : `❌ ${worker.nombre} RECHAZÓ la oferta para OT ${shortOt} en ${ciudadStr}.`;
      try {
        await ctx.telegram.send(tgText);
      } catch (e) {
        ctx.log("warn", "offer-reply: telegram send threw (non-fatal)", {
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }

    // 9. Worker-facing reply. MUST mention "preseleccionado" and
    // "RRHH te contactará" on accept so the next step is unambiguous.
    const ciudadForReply = ciudad ?? "el sitio acordado";
    const reply =
      intent === "accept"
        ? `Listo, ${worker.nombre}. Quedaste preseleccionado para el trabajo en ${ciudadForReply}. El equipo de RRHH te contactará pronto para firmar el contrato. ✅`
        : `Entendido, ${worker.nombre}. Sin problema — te avisamos cuando haya algo más que te encaje.`;

    ctx.log("info", "offer-reply: handled pre-LLM", {
      phone: ctx.phone,
      tecnico_id: offer.tecnico_id,
      ot_row_id: offer.ot_row_id,
      ot_offer_id: offer.id,
      intent,
    });

    return { handled: true, reply };
  } catch (e) {
    // Fail-open: any unexpected error falls through to the LLM, which is the
    // safest default (the worker still gets a response).
    ctx.log("error", "offer-reply failed", {
      phone: ctx.phone,
      error: e instanceof Error ? e.message : String(e),
    });
    return { handled: false };
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

type Intent = "accept" | "reject" | "none";

export function classifyIntent(raw: string): Intent {
  if (!raw) return "none";
  // Normalize: lowercase, trim, strip leading/trailing punctuation/whitespace.
  const normalized = raw
    .toLowerCase()
    .trim()
    .replace(/^[\s.,;:¡!¿?"'`*_-]+/, "")
    .replace(/[\s.,;:¡!¿?"'`*_-]+$/, "");
  if (!normalized) return "none";
  const head = normalized.slice(0, PREFIX_WINDOW);
  // Reject first — it includes "no acepto" which would otherwise be eaten by
  // the accept "acepto" alternation (though accept is start-anchored, leading
  // "no " would still leak through if accept tested first against a non-start
  // index — safer to keep order explicit).
  if (REJECT_RE.test(head)) return "reject";
  if (ACCEPT_RE.test(head)) return "accept";
  return "none";
}

async function loadWorker(
  sb: ServerClient,
  phone: string
): Promise<{ tecnico_id: string; nombre: string } | null> {
  // Try phone column first (the WA identity, primary key for inbound match).
  const byPhone = await sb
    .from("tecnicos_extended")
    .select("tecnico_id, nombre")
    .eq("phone", phone)
    .maybeSingle();
  if (byPhone.data?.tecnico_id) {
    return {
      tecnico_id: byPhone.data.tecnico_id,
      nombre: byPhone.data.nombre ?? "compa",
    };
  }
  // Fallback: contact_phone (the callable number, separate per migration 011).
  const byContact = await sb
    .from("tecnicos_extended")
    .select("tecnico_id, nombre")
    .eq("contact_phone", phone)
    .maybeSingle();
  if (byContact.data?.tecnico_id) {
    return {
      tecnico_id: byContact.data.tecnico_id,
      nombre: byContact.data.nombre ?? "compa",
    };
  }
  return null;
}

async function loadOpenOffer(
  sb: ServerClient,
  tecnicoId: string
): Promise<OpenOffer | null> {
  const nowIso = new Date().toISOString();
  // NOTE: cast to `any` — db-types.ts hasn't been regenerated for ot_offers
  // (migration 014). Same convention as dashboard/offer-actions.ts.
  const { data, error } = await (sb as any)
    .from("ot_offers")
    .select("id, ot_row_id, tecnico_id, state, sent_at, expires_at")
    .eq("tecnico_id", tecnicoId)
    .eq("state", "sent")
    .gt("expires_at", nowIso)
    .order("sent_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    log.error("offer-reply: ot_offers query failed", {
      tecnico_id: tecnicoId,
      error: error.message,
    });
    return null;
  }
  return (data as OpenOffer | null) ?? null;
}

async function loadOtCiudad(
  sb: ServerClient,
  otRowId: string
): Promise<string | null> {
  try {
    const { data } = await sb
      .from("ots_mirror")
      .select("ciudad")
      .eq("row_id", otRowId)
      .maybeSingle();
    const ciudad = data?.ciudad;
    return typeof ciudad === "string" && ciudad.length > 0 ? ciudad : null;
  } catch {
    return null;
  }
}
