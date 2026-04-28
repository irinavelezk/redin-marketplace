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
    meta: args.meta ?? null,
  });
  if (error) {
    // Don't throw — a failed enqueue must not block the HR action that
    // triggered it. The DB write that mattered (postulación / contrato)
    // already succeeded; the missing notification is a softer failure.
    console.error("enqueueWhatsApp failed", { phone, error: error.message });
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
