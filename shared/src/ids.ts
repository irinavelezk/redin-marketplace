// Helpers for phone + id normalization shared across packages.

export function normalizePhone(input: string): string {
  if (!input) return "";
  const trimmed = input.trim();
  // Keep leading '+' if present, then strip everything that isn't a digit.
  const hasPlus = trimmed.startsWith("+");
  const digits = trimmed.replace(/[^\d]/g, "");
  if (!digits) return "";
  return hasPlus ? `+${digits}` : digits;
}

// Colombian number normalization: default +57 if it looks like a 10-digit local number.
export function normalizeColombianPhone(input: string): string {
  const n = normalizePhone(input);
  if (!n) return "";
  if (n.startsWith("+")) return n;
  if (n.length === 10 && (n.startsWith("3") || n.startsWith("6"))) {
    return `+57${n}`;
  }
  return `+${n}`;
}

// Baileys sends JIDs like "573166222563@s.whatsapp.net". Extract a normalized phone.
export function phoneFromJid(jid: string): string {
  const bare = jid.split("@")[0] ?? "";
  const digits = bare.replace(/[^\d]/g, "");
  if (!digits) return "";
  return `+${digits}`;
}

export function jidFromPhone(phone: string): string {
  const digits = phone.replace(/[^\d]/g, "");
  return `${digits}@s.whatsapp.net`;
}
