// OT and tecnico display helpers — extract a human title from an ots_mirror
// row's free-form `data` JSON, and a "nombre · ciudad" line for tecnicos.
// Keeps UUID render-fallbacks out of the page templates.
//
// Used by: hr/pipeline, hr/shortlist, hr/contratos, hr/tecnicos detail.

const OT_DESC_KEYS = [
  "Descripcion",
  "descripcion",
  "Resumen Visual",
  "Actividad_Descripcion",
] as const;

export function otDescripcion(data: unknown): string {
  if (!data || typeof data !== "object" || Array.isArray(data)) return "";
  const d = data as Record<string, unknown>;
  for (const k of OT_DESC_KEYS) {
    const v = d[k];
    if (typeof v === "string" && v.trim().length > 0) return v.trim();
  }
  return "";
}

// "Cleaning de fachada 2026" if the OT carries a description, otherwise
// "Trabajo en Valledupar" if we know the city, otherwise just "Trabajo sin
// título". Never returns the OT row_id — that's a system identifier, not a
// human label. The row_id should appear only as small monospace metadata
// next to the title, never as the primary heading.
export function otTitle(ot: {
  ciudad: string | null;
  data: unknown;
} | null | undefined): string {
  if (!ot) return "Trabajo sin título";
  const desc = otDescripcion(ot.data);
  if (desc) return desc;
  if (ot.ciudad) return `Trabajo en ${ot.ciudad}`;
  return "Trabajo sin título";
}

// "Manuel · Valledupar" if both, "Manuel" if only nombre, "(sin nombre)" if
// nothing. Never returns a UUID slice.
export function tecnicoLabel(args: {
  nombre: string | null | undefined;
  ciudad: string | null | undefined;
}): string {
  const nombre = args.nombre?.trim() || null;
  const ciudad = args.ciudad?.trim() || null;
  if (nombre && ciudad) return `${nombre} · ${ciudad}`;
  if (nombre) return nombre;
  return "(sin nombre)";
}
