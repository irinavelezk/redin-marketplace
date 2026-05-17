// Phone display rules for HR surfaces.
//
// Three distinct phone-shaped values may live on a tecnicos_extended row:
//   contact_phone — explicit callable number captured during screening
//                   (validateIdentity enforces shape). Always the preferred
//                   tel: target when present.
//   phone         — the WhatsApp identifier. For legacy workers backfilled
//                   from AppSheet, this IS the real callable number (came
//                   from the AppSheet Telefono column). For workers who
//                   registered via WhatsApp in privacy mode, this is a
//                   LID — a privacy-only identifier that is NOT callable.
//   last_jid      — the underlying WA JID. Ends with @lid for privacy-mode
//                   workers; ends with @s.whatsapp.net for normal numbers.
//                   Used as the deterministic signal for is-this-a-LID.
//
// Rules:
//   1. If contact_phone is set → use it as tel: target.
//   2. Else if phone is set AND last_jid does NOT end with @lid → phone
//      itself is callable (legacy / direct registration). Use it; don't
//      render a redundant "WA <same number>" line beneath.
//   3. Else → no callable phone. Show the WA value (if any) as an
//      identity-only label for HR reference.

export interface PhoneDisplay {
  /** tel: target — null when no callable phone is available */
  callable: string | null;
  /** WA identity to show on a separate "WA …" line; null when redundant */
  waLabel: string | null;
}

export function phoneDisplay(row: {
  contact_phone?: string | null;
  phone?: string | null;
  last_jid?: string | null;
}): PhoneDisplay {
  const contact = row.contact_phone?.trim() || null;
  const phone = row.phone?.trim() || null;
  const isLid = !!row.last_jid?.endsWith("@lid");

  if (contact) {
    return {
      callable: contact,
      waLabel: phone && phone !== contact ? phone : null,
    };
  }
  if (phone && !isLid) {
    return { callable: phone, waLabel: null };
  }
  return { callable: null, waLabel: phone };
}
