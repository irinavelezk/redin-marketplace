// Cross-process worker notifications. Dashboard cannot send WhatsApp directly
// (Baileys session is exclusive to tono-mp), so we enqueue rows into
// outbound_messages and let tono-mp's runner drain them.

import { normalizePhone } from "@redin/shared";
import type { SupabaseClient } from "@supabase/supabase-js";

export async function enqueueWhatsApp(
  supa: SupabaseClient,
  args: { phone: string; body: string; meta?: Record<string, unknown> }
): Promise<void> {
  const phone = normalizePhone(args.phone);
  if (!phone) {
    console.warn("enqueueWhatsApp skipped: phone empty");
    return;
  }
  const body = args.body.trim();
  if (!body) return;
  const { error } = await supa.from("outbound_messages").insert({
    phone,
    body,
    channel: "whatsapp",
    kind: "text",
    meta: args.meta ?? null,
  });
  if (error) {
    console.error("enqueueWhatsApp failed", { phone, error: error.message });
  }
}

// Sends a Storage-backed document (currently always PDF in the contratos
// bucket) as a WhatsApp document with `body` as caption. The drainer in
// tono-mp downloads the file and forwards it via Baileys' document send.
export async function enqueueWhatsAppDocument(
  supa: SupabaseClient,
  args: {
    phone: string;
    body: string;
    attachment_path: string;
    attachment_filename: string;
    attachment_bucket?: string;
    meta?: Record<string, unknown>;
  }
): Promise<void> {
  const phone = normalizePhone(args.phone);
  if (!phone) {
    console.warn("enqueueWhatsAppDocument skipped: phone empty");
    return;
  }
  const body = args.body.trim();
  if (!args.attachment_path) return;
  const { error } = await supa.from("outbound_messages").insert({
    phone,
    body,
    channel: "whatsapp",
    kind: "document",
    attachment_path: args.attachment_path,
    attachment_filename: args.attachment_filename,
    attachment_bucket: args.attachment_bucket ?? "contratos",
    meta: args.meta ?? null,
  });
  if (error) {
    console.error("enqueueWhatsAppDocument failed", {
      phone,
      attachment_path: args.attachment_path,
      error: error.message,
    });
  }
}

// Resolve the worker's phone + a human-readable OT description for message
// templating. Returns nulls on missing data so callers can degrade gracefully.
export async function tecnicoNotificationContext(
  supa: SupabaseClient,
  tecnicoId: string,
  otId?: string | null
): Promise<{ phone: string | null; descripcion: string | null }> {
  const { data: tec } = await supa
    .from("tecnicos_extended")
    .select("phone")
    .eq("tecnico_id", tecnicoId)
    .maybeSingle();

  let descripcion: string | null = null;
  if (otId) {
    const { data: ot } = await supa
      .from("ots_mirror")
      .select("data")
      .eq("row_id", otId)
      .maybeSingle();
    if (ot?.data && typeof ot.data === "object" && !Array.isArray(ot.data)) {
      const d = ot.data as Record<string, unknown>;
      for (const k of ["Descripcion", "descripcion", "Resumen Visual", "Actividad_Descripcion"]) {
        const v = d[k];
        if (typeof v === "string" && v.trim().length > 0) {
          descripcion = v.trim();
          break;
        }
      }
    }
  }

  return { phone: tec?.phone ?? null, descripcion };
}
