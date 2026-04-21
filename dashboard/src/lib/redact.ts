// Keep client-identifying information out of the public OT view.
// The public board shows only city + especialidad + a cleaned description.

const CLIENT_NAMES = [
  "Davivienda",
  "Tigo",
  "Seguros Bolívar",
  "Bolívar",
  "Casa Limpia",
  "Inter Rapidísimo",
  "Colsanitas",
];

const ADDRESS_HINTS = [
  /\bcra\s?\d+\b/gi,
  /\bcalle\s?\d+\b/gi,
  /\bcll\s?\d+\b/gi,
  /\bav\.?\s?\d+\b/gi,
  /\b#\s?\d+\b/g,
];

export function redactForPublic(text: string, maxLen = 140): string {
  if (!text) return "";
  let out = text;
  for (const name of CLIENT_NAMES) {
    const re = new RegExp(`\\b${escapeRegex(name)}\\b`, "gi");
    out = out.replace(re, "[cliente]");
  }
  for (const re of ADDRESS_HINTS) {
    out = out.replace(re, "[dirección]");
  }
  out = out.replace(/\s+/g, " ").trim();
  if (out.length > maxLen) out = out.slice(0, maxLen - 1) + "…";
  return out;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
