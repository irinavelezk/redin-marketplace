// Shortlist ranking — lex sort matching Jose's mental model exactly.
//
// v1.1 lex order:
//   especialidadFit desc → proximidad desc → disponibilidad desc → calidad desc
//
// Signals:
//   - especialidadFit: subcategoria match 1.0 · especialidad 0.7 · partial 0.4 · none 0.0
//                      When ot_alcance present (from ots_extended), prefer its richer
//                      especialidad/subcategoria fields over AppSheet's Categoria/Subcategoria.
//   - proximidad:      1.0 if worker.ciudad case-insensitive-equals ot.ciudad, else 0.0.
//                      No distance graph in v1.
//   - disponibilidad:  fresher applied_at ranks higher; penalize workers with many open
//                      postulaciones (proxy for capacity).
//   - calidad:         internal performance avg_score (1–5) from tecnico_performance view.
//                      Null if the worker has no evaluations yet. NULLS LAST.
//
// costo tier removed entirely — rateByTecnico was always null; no clean rate-per-worker
// data. Re-add as 5th tier once Redin has it.

import type { PostulacionRow } from "@redin/shared";

// Alcance subset surfaced from ots_extended (Stream A migration 012).
// Present only when the architect has enriched the OT via Manos.
export interface OtAlcance {
  especialidad?: string | null;
  subcategoria?: string | null;
}

// Worker profile fields required for the new signals.
export interface WorkerProfile {
  ciudad: string | null;
  especialidades: string[] | null;
}

export interface RankingInputs {
  postulaciones: PostulacionRow[];
  // openPosByTecnico[tecnico_id] = count of their non-terminal postulaciones
  openPosByTecnico: Map<string, number>;
  // avg stars per tecnico, null if no ratings
  ratingByTecnico: Map<string, number | null>;
  // Per-worker profile for especialidadFit + proximidad signals.
  // Key: tecnico_id.  Missing key → treat as unknown worker (signals = 0).
  workerProfiles?: Map<string, WorkerProfile>;
  // Per-OT alcance from ots_extended (richer signal when present).
  // Key: ot_id. Missing key or value → fall back to ots_mirror.especialidad.
  otAlcance?: Map<string, OtAlcance | null>;
  // OT-level fields needed for the new signals (city + speciality).
  // Key: ot_id.
  otFields?: Map<string, { ciudad: string | null; especialidad: string | null; subcategoria?: string | null }>;
}

export interface RankedPostulacion {
  postulacion: PostulacionRow;
  scores: {
    especialidadFit: number; // 0..1 — higher is better
    proximidad: number;      // 0 or 1
    disponibilidad: number;  // 0..1 — higher is better
    calidad: number | null;  // 1..5, null if no evals (NULLS LAST)
  };
}

// ---------------------------------------------------------------------------
// Helpers — exported so Stream D and read_pending_ots can reuse them directly
// ---------------------------------------------------------------------------

function normalizeStr(s: string): string {
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
 *   0.4  any partial overlap in the set intersection
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

  // Prefer alcance fields when present (richer)
  const effectiveEspec =
    otAlcance?.especialidad ?? otEspecialidad ?? null;
  const effectiveSubcat =
    otAlcance?.subcategoria ?? otSubcategoria ?? null;

  const workerNorm = workerEspecialidades
    .map(normalizeStr)
    .filter((s) => s.length > 0);
  if (workerNorm.length === 0) return 0;

  const otEspecNorm = effectiveEspec ? normalizeStr(effectiveEspec) : null;
  const otSubcatNorm = effectiveSubcat ? normalizeStr(effectiveSubcat) : null;

  // 1.0 — subcategoria exact match
  if (otSubcatNorm && workerNorm.some((w) => w === otSubcatNorm)) return 1.0;

  // 0.7 — especialidad exact match
  if (otEspecNorm && workerNorm.some((w) => w === otEspecNorm)) return 0.7;

  // 0.4 — any partial overlap (substring in either direction)
  if (
    otEspecNorm &&
    workerNorm.some(
      (w) => w.includes(otEspecNorm) || otEspecNorm.includes(w)
    )
  )
    return 0.4;
  if (
    otSubcatNorm &&
    workerNorm.some(
      (w) => w.includes(otSubcatNorm) || otSubcatNorm.includes(w)
    )
  )
    return 0.4;

  return 0.0;
}

/**
 * proximidad — 1.0 if worker.ciudad case-insensitively equals ot.ciudad (trimmed,
 * diacritics-stripped), else 0.0. No distance graph in v1.
 */
export function proximidad(
  workerCiudad: string | null | undefined,
  otCiudad: string | null | undefined
): number {
  if (!workerCiudad || !otCiudad) return 0;
  return normalizeStr(workerCiudad) === normalizeStr(otCiudad) ? 1.0 : 0.0;
}

// ---------------------------------------------------------------------------

const MAX_OPEN_POS_PENALTY = 3; // more than this and disponibilidad collapses

export function rankPostulaciones(inputs: RankingInputs): RankedPostulacion[] {
  const now = Date.now();
  const FRESH_WINDOW_MS = 24 * 3600 * 1000 * 7; // 1 week = fully fresh

  const scored: RankedPostulacion[] = inputs.postulaciones.map((p) => {
    // --- disponibilidad (unchanged helper) ---
    const applied = new Date(p.applied_at).getTime();
    const ageMs = now - applied;
    const freshness = Math.max(0, 1 - Math.min(ageMs / FRESH_WINDOW_MS, 1));
    const openCount = inputs.openPosByTecnico.get(p.tecnico_id) ?? 0;
    const loadPenalty = Math.min(openCount / MAX_OPEN_POS_PENALTY, 1);
    const disponibilidad = Math.max(0, freshness * (1 - loadPenalty));

    // --- calidad (unchanged helper) ---
    const calidad = inputs.ratingByTecnico.get(p.tecnico_id) ?? null;

    // --- new signals ---
    const worker = inputs.workerProfiles?.get(p.tecnico_id) ?? null;
    const otF = inputs.otFields?.get(p.ot_id) ?? null;
    const alcance = inputs.otAlcance?.get(p.ot_id) ?? null;

    const fitScore = especialidadFit(
      worker?.especialidades ?? null,
      otF?.especialidad ?? null,
      otF?.subcategoria ?? null,
      alcance
    );
    const proxScore = proximidad(worker?.ciudad ?? null, otF?.ciudad ?? null);

    return {
      postulacion: p,
      scores: {
        especialidadFit: fitScore,
        proximidad: proxScore,
        disponibilidad,
        calidad,
      },
    };
  });

  scored.sort((a, b) => {
    // especialidadFit desc
    if (b.scores.especialidadFit !== a.scores.especialidadFit) {
      return b.scores.especialidadFit - a.scores.especialidadFit;
    }
    // proximidad desc
    if (b.scores.proximidad !== a.scores.proximidad) {
      return b.scores.proximidad - a.scores.proximidad;
    }
    // disponibilidad desc
    if (b.scores.disponibilidad !== a.scores.disponibilidad) {
      return b.scores.disponibilidad - a.scores.disponibilidad;
    }
    // calidad desc (nulls last)
    const qa = a.scores.calidad ?? -1;
    const qb = b.scores.calidad ?? -1;
    return qb - qa;
  });

  return scored;
}
