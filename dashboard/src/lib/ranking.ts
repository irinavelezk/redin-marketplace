// Shortlist ranking per Jose's explicit order: disponibilidad → calidad → costo.
//
// v1 signals are thin. We score:
//   - disponibilidad: fresher applied_at ranks higher (proxy for "still responsive");
//                     penalize técnicos with 2+ open postulaciones already elsewhere
//   - calidad:       rating average (ratings.stars) — null if no history
//   - costo:         tecnico self-reported rate if present in tecnicos_extended meta;
//                    otherwise neutral (no signal — all tied)
//
// We intentionally avoid a single fused score — instead we sort lexicographically
// so the ordering matches Jose's mental model exactly.

import type { PostulacionRow } from "@redin/shared";

export interface RankingInputs {
  postulaciones: PostulacionRow[];
  // openPosByTecnico[tecnico_id] = count of their non-terminal postulaciones
  openPosByTecnico: Map<string, number>;
  // avg stars per tecnico, null if no ratings
  ratingByTecnico: Map<string, number | null>;
  // self-reported hourly or fixed rate, lower is better (cop). null if unknown.
  rateByTecnico: Map<string, number | null>;
}

export interface RankedPostulacion {
  postulacion: PostulacionRow;
  scores: {
    disponibilidad: number; // 0..1 — higher is better
    calidad: number | null;
    costo: number | null; // cop, lower is better
  };
}

const MAX_OPEN_POS_PENALTY = 3; // more than this and disponibilidad collapses

export function rankPostulaciones(inputs: RankingInputs): RankedPostulacion[] {
  const now = Date.now();
  const FRESH_WINDOW_MS = 24 * 3600 * 1000 * 7; // 1 week = fully fresh

  const scored: RankedPostulacion[] = inputs.postulaciones.map((p) => {
    const applied = new Date(p.applied_at).getTime();
    const ageMs = now - applied;
    const freshness = Math.max(0, 1 - Math.min(ageMs / FRESH_WINDOW_MS, 1));
    const openCount = inputs.openPosByTecnico.get(p.tecnico_id) ?? 0;
    const loadPenalty = Math.min(openCount / MAX_OPEN_POS_PENALTY, 1);
    const disponibilidad = Math.max(0, freshness * (1 - loadPenalty));
    const calidad = inputs.ratingByTecnico.get(p.tecnico_id) ?? null;
    const costo = inputs.rateByTecnico.get(p.tecnico_id) ?? null;
    return {
      postulacion: p,
      scores: { disponibilidad, calidad, costo },
    };
  });

  scored.sort((a, b) => {
    // disponibilidad desc
    if (b.scores.disponibilidad !== a.scores.disponibilidad) {
      return b.scores.disponibilidad - a.scores.disponibilidad;
    }
    // calidad desc (nulls last)
    const qa = a.scores.calidad ?? -1;
    const qb = b.scores.calidad ?? -1;
    if (qb !== qa) return qb - qa;
    // costo asc (nulls last so they sort after scored entries)
    const ca = a.scores.costo ?? Number.POSITIVE_INFINITY;
    const cb = b.scores.costo ?? Number.POSITIVE_INFINITY;
    return ca - cb;
  });

  return scored;
}
