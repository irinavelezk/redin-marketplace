// sendOffer — HR-triggered per-(OT, técnico) job offer for state-4 OTs.
//
// Flow (see migration 014_ot_offers.sql for the data-model contract):
//   1. Validate HR session, OT state, tecnico approval, alcance PDF presence.
//   2. INSERT ot_offers row (state='sent'). Partial unique index on
//      (ot_row_id, tecnico_id) WHERE state='sent' enforces single-active.
//   3. Insert two outbound_messages rows directly (so we capture the IDs):
//      a) kind='text' — the greeting + ask body
//      b) kind='document' — the alcance PDF as a WhatsApp attachment
//   4. Patch ot_offers with the two message IDs.
//   5. Log eventos.offer_sent.
//   6. Ping HR Telegram (best-effort; skipped if env not configured).
//
// Note: enqueueWhatsApp() in lib/notify.ts does not return the inserted row's
// id, so we insert into outbound_messages directly here to capture them for
// the FK columns on ot_offers.text_message_id / document_message_id.

"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { serverClientBoundToCookies, serviceClient } from "@/lib/supabase-server";
import { normalizePhone } from "@redin/shared";

// Cleanest formatter for the message text. NOT exported — Next.js requires
// every export from a "use server" module to be an async function. The function
// only has one caller (sendOffer below), so keeping it internal is fine.
function buildOfferMessageBody(args: {
  workerNombre: string;
  otCiudad: string;
}): string {
  return `Hola ${args.workerNombre}, soy Toño de Redin. Tengo un trabajo para ti en ${args.otCiudad}.\n\nTe paso el alcance del trabajo en el documento que adjunto. Revísalo bien.\n\n¿Aceptas o pasas? Responde "acepto" o "paso".`;
}

// Best-effort Telegram ping to the HR chat. Uses the same env vars as the
// Toño escalation sink (TELEGRAM_BOT_TOKEN + HR_TELEGRAM_CHAT_ID). Silent
// no-op when not configured — leaves a console.warn for ops visibility.
async function pingHrTelegram(text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.HR_TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.warn("sendOffer: HR Telegram not configured, skipping ping");
    return;
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.warn("sendOffer: HR Telegram send failed", {
        status: res.status,
        body: body.slice(0, 200),
      });
    }
  } catch (e) {
    console.warn("sendOffer: HR Telegram threw", {
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

export type SendOfferResult =
  | { ok: true; ot_offer_id: string }
  | { ok: false; error: string };

export async function sendOffer(formData: FormData): Promise<void> {
  const result = await sendOfferImpl(formData);
  // Pattern matches decide()/createContract(): just revalidate and return.
  // The UI surface for errors is currently a console log + revalidate; a
  // future iteration can return the result to a useFormState hook on the
  // client. For now we log unhandled errors so they show in server logs.
  if (!result.ok) {
    console.error("sendOffer failed:", result.error);
  }
}

async function sendOfferImpl(formData: FormData): Promise<SendOfferResult> {
  // 1. Auth — match decide() pattern.
  const auth = serverClientBoundToCookies();
  const { data: userData } = await auth.auth.getUser();
  if (!userData.user) redirect("/login");
  const hrEmail = userData.user.email ?? userData.user.id;

  const supa = serviceClient();

  // 2. Read + validate form fields.
  const otRowId = formData.get("ot_row_id");
  const tecnicoId = formData.get("tecnico_id");
  if (typeof otRowId !== "string" || typeof tecnicoId !== "string") {
    return { ok: false, error: "missing_form_fields" };
  }

  // 3. Preconditions.
  // 3a. OT exists and is state 4.
  const { data: ot } = await supa
    .from("ots_mirror")
    .select("row_id, ciudad, estado")
    .eq("row_id", otRowId)
    .maybeSingle();
  if (!ot) {
    return { ok: false, error: "OT no encontrada" };
  }
  if (!ot.estado || !ot.estado.startsWith("4.")) {
    return {
      ok: false,
      error: `Solo se pueden enviar ofertas en estado 4. (actual: ${ot.estado ?? "—"})`,
    };
  }
  const otCiudad = ot.ciudad ?? "tu ciudad";

  // 3b. Técnico must be approved + activo.
  const { data: tec } = await supa
    .from("tecnicos_extended")
    .select("tecnico_id, nombre, phone, contact_phone, candidate_state, estado")
    .eq("tecnico_id", tecnicoId)
    .maybeSingle();
  if (!tec) {
    return { ok: false, error: "Técnico no encontrado" };
  }
  if (tec.candidate_state !== "approved" || tec.estado !== "activo") {
    return {
      ok: false,
      error: `El técnico no está aprobado y activo (candidate_state=${tec.candidate_state}, estado=${tec.estado})`,
    };
  }

  // 3c. alcance PDF must exist (we MUST send a document). ots_extended is
  // typed in db-types but the table may be very new — wrap in try to degrade
  // gracefully if it's somehow missing.
  let alcancePdfPath: string | null = null;
  try {
    const { data: ext } = await supa
      .from("ots_extended")
      .select("alcance_pdf_path")
      .eq("ot_row_id", otRowId)
      .maybeSingle();
    alcancePdfPath = ext?.alcance_pdf_path ?? null;
  } catch {
    alcancePdfPath = null;
  }
  if (!alcancePdfPath) {
    return {
      ok: false,
      error: "No se puede enviar oferta: falta el alcance en PDF. Pídele al arquitecto que cierre el alcance primero.",
    };
  }

  // 3d. Worker phone must be present.
  const phoneRaw = tec.contact_phone ?? tec.phone ?? null;
  const phone = phoneRaw ? normalizePhone(phoneRaw) : null;
  if (!phone) {
    return { ok: false, error: "El técnico no tiene un teléfono de contacto registrado" };
  }

  const workerNombre = tec.nombre?.trim() || "técnico";

  // 4. Insert ot_offers row first (state='sent') — message IDs patched in step 6.
  // TODO: regenerate types after migration 014 applies — using (supa as any).
  const expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString();
  const { data: offerRow, error: offerErr } = await (supa as any)
    .from("ot_offers")
    .insert({
      ot_row_id: otRowId,
      tecnico_id: tecnicoId,
      state: "sent",
      sent_at: new Date().toISOString(),
      expires_at: expiresAt,
      hr_user_email: hrEmail,
    })
    .select("id")
    .single();

  if (offerErr || !offerRow) {
    // Postgres unique_violation = 23505 — surfaces when a sent offer already exists.
    const code = (offerErr as { code?: string } | null)?.code;
    if (code === "23505") {
      return {
        ok: false,
        error: "Ya hay una oferta activa para este técnico en esta OT",
      };
    }
    console.error("sendOffer: ot_offers insert failed", offerErr);
    return { ok: false, error: "No se pudo crear la oferta (DB error)" };
  }
  const otOfferId = offerRow.id as string;

  // 5. Enqueue both outbound_messages rows (text first, then document) — we
  // insert directly so we can capture the IDs to link back to ot_offers.
  const body = buildOfferMessageBody({ workerNombre, otCiudad });

  const { data: textRow, error: textErr } = await supa
    .from("outbound_messages")
    .insert({
      phone,
      body,
      channel: "whatsapp",
      kind: "text",
      meta: {
        kind: "ot_offer_text",
        ot_row_id: otRowId,
        tecnico_id: tecnicoId,
        ot_offer_id: otOfferId,
      },
    })
    .select("id")
    .single();

  if (textErr || !textRow) {
    console.error("sendOffer: outbound text insert failed", textErr);
    return { ok: false, error: "No se pudo encolar el mensaje de WhatsApp" };
  }

  const docCaption = `Alcance del trabajo — OT ${otRowId.slice(0, 8)}`;
  const docFilename = `Alcance_OT_${otRowId.slice(0, 8)}.pdf`;

  const { data: docRow, error: docErr } = await supa
    .from("outbound_messages")
    .insert({
      phone,
      body: docCaption,
      channel: "whatsapp",
      kind: "document",
      attachment_path: alcancePdfPath,
      attachment_bucket: "alcance-photos",
      attachment_filename: docFilename,
      meta: {
        kind: "ot_offer_pdf",
        ot_row_id: otRowId,
        tecnico_id: tecnicoId,
        ot_offer_id: otOfferId,
      },
    })
    .select("id")
    .single();

  if (docErr || !docRow) {
    console.error("sendOffer: outbound document insert failed", docErr);
    return { ok: false, error: "No se pudo encolar el documento de WhatsApp" };
  }

  // 6. Patch ot_offers with the message IDs.
  // TODO: regenerate types after migration 014 applies.
  const { error: updErr } = await (supa as any)
    .from("ot_offers")
    .update({
      text_message_id: textRow.id,
      document_message_id: docRow.id,
    })
    .eq("id", otOfferId);
  if (updErr) {
    // Non-fatal — messages are already queued. Log it.
    console.error("sendOffer: ot_offers patch with message_ids failed", updErr);
  }

  // 7. Log eventos.offer_sent.
  await supa.from("eventos").insert({
    type: "offer_sent",
    entity_id: otRowId,
    actor: `hr:${hrEmail}`,
    meta: {
      tecnico_id: tecnicoId,
      ot_offer_id: otOfferId,
      hr_user_email: hrEmail,
    },
  });

  // 8. Ping HR Telegram (best-effort, env-gated).
  // Worker ciudad lives in eventos.tecnico_registered.meta — fetch latest
  // for a slightly more informative ping. Cheap query, fail silently.
  let workerCiudad = "—";
  try {
    const { data: regEv } = await supa
      .from("eventos")
      .select("meta")
      .eq("type", "tecnico_registered")
      .eq("entity_id", tecnicoId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const m = regEv?.meta as Record<string, unknown> | null;
    if (m && typeof m.ciudad === "string" && m.ciudad.trim()) {
      workerCiudad = m.ciudad;
    }
  } catch {
    // ignore — telegram ping is best-effort
  }
  await pingHrTelegram(
    `Oferta enviada a ${workerNombre} (${workerCiudad}) para OT ${otRowId.slice(0, 8)} en ${otCiudad}.`
  );

  // 9. Revalidate the shortlist page so HR sees the offer state immediately.
  revalidatePath(`/hr/shortlist/${encodeURIComponent(otRowId)}`);
  revalidatePath("/hr/pipeline");

  return { ok: true, ot_offer_id: otOfferId };
}
