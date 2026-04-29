// Drains the outbound_messages queue. dashboard-mp's HR actions enqueue rows;
// this loop in tono-mp picks them up and sends via Baileys (the only process
// that holds the WhatsApp socket).
//
// Single-instance assumption: only one tono-mp replica runs in production.
// If we ever scale tono-mp to >1, we'll need row-level locking (SELECT FOR
// UPDATE SKIP LOCKED) — Supabase REST doesn't expose that, so we'd switch
// to a Postgres function. Not relevant at v1 scale.

import { createLogger, jidFromPhone } from "@redin/shared";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { WhatsAppClient } from "./whatsapp";

const log = createLogger("tono:outbound");

const POLL_INTERVAL_MS = 5_000;
const BATCH_SIZE = 10;
const MAX_ATTEMPTS = 3;

export interface OutboundDrainerOpts {
  supabase: SupabaseClient;
  wa: WhatsAppClient;
  isReady: () => boolean;
}

export function startOutboundDrainer(opts: OutboundDrainerOpts): () => void {
  const { supabase, wa, isReady } = opts;
  let inFlight = false;

  const tick = async () => {
    if (inFlight) return;
    if (!isReady()) return;
    inFlight = true;
    try {
      const { data, error } = await supabase
        .from("outbound_messages")
        .select(
          "id, phone, body, attempts, kind, attachment_path, attachment_filename, attachment_bucket"
        )
        .eq("status", "pending")
        .lt("attempts", MAX_ATTEMPTS)
        .order("created_at", { ascending: true })
        .limit(BATCH_SIZE);
      if (error) {
        log.error("poll failed", { error: error.message });
        return;
      }
      for (const row of data ?? []) {
        // Prefer the persisted inbound JID over a phone-rebuilt JID. The
        // rebuilt one hardcodes "@s.whatsapp.net" and silently misses
        // LID-mode accounts ("<digits>@lid"). See migration 004.
        const { data: tec } = await supabase
          .from("tecnicos_extended")
          .select("last_jid")
          .eq("phone", row.phone)
          .maybeSingle();
        const jid =
          (tec as { last_jid: string | null } | null)?.last_jid ??
          jidFromPhone(row.phone);
        if (!jid || !jid.includes("@")) {
          await markFailed(supabase, row.id, "invalid phone");
          continue;
        }
        try {
          if (row.kind === "document" && row.attachment_path) {
            const bucket = row.attachment_bucket ?? "contratos";
            const { data: blob, error: dlErr } = await supabase.storage
              .from(bucket)
              .download(row.attachment_path);
            if (dlErr || !blob) {
              throw new Error(`storage download failed: ${dlErr?.message ?? "no blob"}`);
            }
            const arrBuf = await blob.arrayBuffer();
            const buffer = Buffer.from(arrBuf);
            await wa.sendDocument(jid, buffer, {
              fileName: row.attachment_filename ?? "documento.pdf",
              mimetype: "application/pdf",
              caption: row.body,
            });
          } else {
            await wa.sendText(jid, row.body);
          }
          await markSent(supabase, row.id);
          log.info("sent", { id: row.id, phone: row.phone, jid, kind: row.kind ?? "text" });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          await markRetry(supabase, row.id, (row.attempts ?? 0) + 1, msg);
          log.error("send failed", { id: row.id, error: msg });
        }
      }
    } finally {
      inFlight = false;
    }
  };

  // First tick after a short delay so Baileys has time to come up after boot.
  setTimeout(() => {
    void tick();
  }, 2_000);
  const handle = setInterval(() => {
    void tick();
  }, POLL_INTERVAL_MS);
  return () => clearInterval(handle);
}

async function markSent(supa: SupabaseClient, id: string): Promise<void> {
  await supa
    .from("outbound_messages")
    .update({ status: "sent", sent_at: new Date().toISOString() })
    .eq("id", id);
}

async function markFailed(
  supa: SupabaseClient,
  id: string,
  error: string
): Promise<void> {
  await supa
    .from("outbound_messages")
    .update({ status: "failed", last_error: error })
    .eq("id", id);
}

async function markRetry(
  supa: SupabaseClient,
  id: string,
  attempts: number,
  error: string
): Promise<void> {
  const status = attempts >= MAX_ATTEMPTS ? "failed" : "pending";
  await supa
    .from("outbound_messages")
    .update({ attempts, last_error: error, status })
    .eq("id", id);
}
