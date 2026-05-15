// Pure matching-signal helpers — no I/O, no LLM.
// Used by:
//   - @redin/tools/read-pending-ots (worker feed ranking + filter)
//   - @redin/dashboard ranking.ts (shortlist lex sort)
//   - @redin/tools/recommend-shortlist-candidate (Stream D)

// Alcance subset surfaced from ots_extended (Stream A migration 012).
// Present only when the architect has enriched the OT via Manos.
export interface OtAlcance {
  especialidad?: string | null;
  subcategoria?: string | null;
}

// Worker profile fields required for the matching signals.
export interface WorkerProfile {
  ciudad: string | null;
  especialidades: string[] | null;
}

export function normalizeMatchStr(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();
}

/**
 * especialidadFit — 0..1.
 *
 * Scoring:
 *   1.0  subcategoria exact match (case-insensitive, trimmed, diacritics-stripped)
 *   0.7  especialidad exact match
 *   0.4  any partial overlap in the set intersection (substring match either way)
 *   0.0  no overlap
 *
 * When ot_alcance is present, its especialidad/subcategoria fields take
 * precedence over the AppSheet Categoria/Subcategoria (richer architect-supplied
 * data). Falls back gracefully if either side is null/empty.
 */
export function especialidadFit(
  workerEspecialidades: string[] | null | undefined,
  otEspecialidad: string | null | undefined,
  otSubcategoria: string | null | undefined,
  otAlcance?: OtAlcance | null
): number {
  if (!workerEspecialidades || workerEspecialidades.length === 0) return 0;

  // Prefer alcance fields when present (richer architect-supplied data)
  const effectiveEspec =
    otAlcance?.especialidad ?? otEspecialidad ?? null;
  const effectiveSubcat =
    otAlcance?.subcategoria ?? otSubcategoria ?? null;

  const workerNorm = workerEspecialidades
    .map(normalizeMatchStr)
    .filter((s) => s.length > 0);
  if (workerNorm.length === 0) return 0;

  const otEspecNorm = effectiveEspec ? normalizeMatchStr(effectiveEspec) : null;
  const otSubcatNorm = effectiveSubcat ? normalizeMatchStr(effectiveSubcat) : null;

  // 1.0 — subcategoria exact match
  if (otSubcatNorm && workerNorm.some((w) => w === otSubcatNorm)) return 1.0;

  // 0.7 — especialidad exact match
  if (otEspecNorm && workerNorm.some((w) => w === otEspecNorm)) return 0.7;

  // 0.4 — any partial overlap (substring in either direction)
  if (
    otEspecNorm &&
    workerNorm.some(
      (w) => w.includes(otEspecNorm!) || otEspecNorm!.includes(w)
    )
  )
    return 0.4;
  if (
    otSubcatNorm &&
    workerNorm.some(
      (w) => w.includes(otSubcatNorm!) || otSubcatNorm!.includes(w)
    )
  )
    return 0.4;

  return 0.0;
}

/**
 * proximidad — 1.0 if worker.ciudad case-insensitively equals ot.ciudad
 * (trimmed, diacritics-stripped), else 0.0. No distance graph in v1.
 */
export function proximidad(
  workerCiudad: string | null | undefined,
  otCiudad: string | null | undefined
): number {
  if (!workerCiudad || !otCiudad) return 0;
  return normalizeMatchStr(workerCiudad) === normalizeMatchStr(otCiudad)
    ? 1.0
    : 0.0;
}
