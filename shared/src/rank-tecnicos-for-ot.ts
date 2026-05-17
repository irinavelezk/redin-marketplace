// rankTecnicosForOT — v1 matching engine.
//
// Given an OT row_id, returns the top-N approved técnicos ranked for it, with
// human-readable Spanish reasons per candidate. Pure read-only — no writes.
//
// Reuses especialidadFit + proximidad from ./matching-signals (single source of
// truth — also used by dashboard/lib/ranking.ts and tools/read-pending-ots.ts).
//
// Bulk-loading approach (matches dashboard/src/app/hr/shortlist/[ot_id]/page.tsx):
//   - eventos.tecnico_registered: ONE query in (...tecnicoIds), latest first;
//     dedupe in-app by entity_id (latest event wins).
//   - tecnico_performance view: ONE .in() query.
//   - candidate_dossiers: ONE .in() query, ordered desc; first-seen-per-tecnico in-app.
// No N+1.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json, OtsExtendedRow } from "./db-types";
import { especialidadFit, proximidad, type OtAlcance } from "./matching-signals";

export type RankedTecnico = {
  tecnico_id: string;
  nombre: string;
  ciudad: string | null;
  especialidades: string[]; // what we matched against (worker side)
  score_fit: number; // 0..1 from especialidadFit
  score_proximidad: number; // 0..1 from proximidad
  score_calidad: number | null; // avg_score from tecnico_performance; null if no evals
  eval_count: number; // # past evaluations (0 when no row in performance view)
  anos_experiencia: number | null; // from latest candidate_dossier; null if absent
  reasons: string[]; // Spanish, 2-4 bullets per candidate
};

export type RankTecnicosResult = {
  ot_row_id: string;
  ot_ciudad: string | null;
  ot_especialidad: string | null; // resolved from alcance > mirror fallback
  alcance_source: "alcance" | "mirror" | "none";
  total_approved: number; // pool size before ranking truncation
  ranked: RankedTecnico[]; // sorted, truncated to limit
};

// Internal helper: pull alcance especialidad/subcategoria fields out of the
// arbitrary Json blob — defensively, since alcance_jsonb is Json | null.
function parseAlcance(
  alcance_jsonb: Json | null | undefined
): OtAlcance | null {
  if (
    !alcance_jsonb ||
    typeof alcance_jsonb !== "object" ||
    Array.isArray(alcance_jsonb)
  ) {
    return null;
  }
  const a = alcance_jsonb as Record<string, unknown>;
  return {
    especialidad: typeof a.especialidad === "string" ? a.especialidad : null,
    subcategoria: typeof a.subcategoria === "string" ? a.subcategoria : null,
  };
}

// Build the human-readable OT especialidad label by concatenating the resolved
// especialidad with the subcategoria when both are present:
//   "Eléctrico y Datos — Cableado UTP"
function composeOtEspecialidadLabel(
  especialidad: string | null,
  subcategoria: string | null
): string | null {
  if (especialidad && subcategoria) return `${especialidad} — ${subcategoria}`;
  return especialidad ?? subcategoria ?? null;
}

export async function rankTecnicosForOT(
  supabase: SupabaseClient<Database>,
  otRowId: string,
  opts?: { limit?: number }
): Promise<RankTecnicosResult> {
  const limit = opts?.limit ?? 10;

  // 1. Load OT data in parallel.
  const [mirrorRes, extendedRes] = await Promise.all([
    supabase
      .from("ots_mirror")
      .select("row_id, ciudad, especialidad")
      .eq("row_id", otRowId)
      .maybeSingle(),
    supabase
      .from("ots_extended")
      .select("ot_row_id, alcance_jsonb")
      .eq("ot_row_id", otRowId)
      .maybeSingle(),
  ]);

  const otCiudad = mirrorRes.data?.ciudad ?? null;
  const mirrorEspec = mirrorRes.data?.especialidad ?? null;
  // ots_extended may not exist — error is non-fatal (graceful degrade).
  const extendedRow = (extendedRes.data ?? null) as Pick<
    OtsExtendedRow,
    "alcance_jsonb"
  > | null;
  const alcance = parseAlcance(extendedRow?.alcance_jsonb ?? null);

  // Resolve the OT especialidad string: alcance.especialidad > mirror.especialidad > null.
  let resolvedEspec: string | null;
  let alcanceSource: "alcance" | "mirror" | "none";
  if (alcance?.especialidad && alcance.especialidad.trim().length > 0) {
    resolvedEspec = alcance.especialidad;
    alcanceSource = "alcance";
  } else if (mirrorEspec && mirrorEspec.trim().length > 0) {
    resolvedEspec = mirrorEspec;
    alcanceSource = "mirror";
  } else {
    resolvedEspec = null;
    alcanceSource = "none";
  }

  // ot_especialidad in the output = composed label (especialidad — subcategoria).
  const ot_especialidad = composeOtEspecialidadLabel(
    resolvedEspec,
    alcance?.subcategoria ?? null
  );

  // 2. Hard filter approved + active roster.
  const { data: tecRows, error: tecErr } = await supabase
    .from("tecnicos_extended")
    .select("tecnico_id, nombre, candidate_state, estado, onboarded_at")
    .eq("candidate_state", "approved")
    .eq("estado", "activo");

  if (tecErr) {
    throw new Error(`rankTecnicosForOT: tecnicos_extended query failed: ${tecErr.message}`);
  }

  const approved = tecRows ?? [];
  const total_approved = approved.length;

  if (total_approved === 0) {
    return {
      ot_row_id: otRowId,
      ot_ciudad: otCiudad,
      ot_especialidad,
      alcance_source: alcanceSource,
      total_approved: 0,
      ranked: [],
    };
  }

  const tecnicoIds = approved.map((t) => t.tecnico_id);

  // 3. Bulk-load worker signals in parallel (same pattern as dashboard shortlist page).
  const [eventsRes, perfRes, dossierRes] = await Promise.all([
    // Latest tecnico_registered event per worker. Order desc, dedupe in-app.
    supabase
      .from("eventos")
      .select("entity_id, meta, created_at")
      .eq("type", "tecnico_registered")
      .in("entity_id", tecnicoIds)
      .order("created_at", { ascending: false }),
    // tecnico_performance — left-join semantics (missing rows = no evals).
    supabase
      .from("tecnico_performance")
      .select("tecnico_id, avg_score, eval_count")
      .in("tecnico_id", tecnicoIds),
    // candidate_dossiers — latest per worker. Order desc, first-seen-wins.
    supabase
      .from("candidate_dossiers")
      .select("tecnico_id, payload, created_at")
      .in("tecnico_id", tecnicoIds)
      .order("created_at", { ascending: false }),
  ]);

  // ---- workerProfile map (ciudad + especialidades) from eventos.meta ----
  type WorkerProfile = { ciudad: string | null; especialidades: string[] };
  const profileByTec = new Map<string, WorkerProfile>();
  for (const e of eventsRes.data ?? []) {
    if (!e.entity_id || profileByTec.has(e.entity_id)) continue; // first-seen = latest
    const meta = e.meta as Record<string, unknown> | null;
    const ciudad =
      meta && typeof meta.ciudad === "string" ? meta.ciudad : null;
    const especialidades =
      meta && Array.isArray(meta.especialidades)
        ? (meta.especialidades as unknown[]).filter(
            (x): x is string => typeof x === "string"
          )
        : [];
    profileByTec.set(e.entity_id, { ciudad, especialidades });
  }

  // ---- performance map ----
  type PerfEntry = { avg_score: number | null; eval_count: number };
  const perfByTec = new Map<string, PerfEntry>();
  for (const p of perfRes.data ?? []) {
    perfByTec.set(p.tecnico_id, {
      avg_score: p.avg_score,
      eval_count: p.eval_count,
    });
  }

  // ---- dossier map: latest anos_experiencia per worker ----
  const anosByTec = new Map<string, number | null>();
  for (const d of dossierRes.data ?? []) {
    if (anosByTec.has(d.tecnico_id)) continue; // first-seen = latest
    const payload = d.payload as Record<string, unknown> | null;
    const raw = payload && typeof payload === "object" ? payload.anos_experiencia : null;
    const anos = typeof raw === "number" && Number.isFinite(raw) ? raw : null;
    anosByTec.set(d.tecnico_id, anos);
  }

  // 4. Score every approved técnico.
  type Scored = {
    tec: (typeof approved)[number];
    profile: WorkerProfile;
    score_fit: number;
    score_proximidad: number;
    score_calidad: number | null;
    eval_count: number;
    anos_experiencia: number | null;
  };

  const scored: Scored[] = approved.map((tec) => {
    const profile = profileByTec.get(tec.tecnico_id) ?? {
      ciudad: null,
      especialidades: [],
    };
    const perf = perfByTec.get(tec.tecnico_id) ?? { avg_score: null, eval_count: 0 };
    const anos = anosByTec.get(tec.tecnico_id) ?? null;

    const score_fit = especialidadFit(
      profile.especialidades,
      resolvedEspec,
      alcance?.subcategoria ?? null,
      alcance ?? null
    );
    const score_proximidad = proximidad(profile.ciudad, otCiudad);
    const score_calidad =
      perf.eval_count > 0 && perf.avg_score !== null ? perf.avg_score : null;

    return {
      tec,
      profile,
      score_fit,
      score_proximidad,
      score_calidad,
      eval_count: perf.eval_count,
      anos_experiencia: anos,
    };
  });

  // 5. Lex sort (stable — Array.prototype.sort is stable in V8/modern JS).
  scored.sort((a, b) => {
    // PRIMARY: score_fit desc
    if (b.score_fit !== a.score_fit) return b.score_fit - a.score_fit;
    // TIE-1: score_proximidad desc
    if (b.score_proximidad !== a.score_proximidad)
      return b.score_proximidad - a.score_proximidad;
    // TIE-2: score_calidad desc, NULLS LAST
    const qa = a.score_calidad ?? -Infinity;
    const qb = b.score_calidad ?? -Infinity;
    if (qb !== qa) return qb - qa;
    // TIE-3: anos_experiencia desc, NULLS LAST
    const ea = a.anos_experiencia ?? -Infinity;
    const eb = b.anos_experiencia ?? -Infinity;
    if (eb !== ea) return eb - ea;
    // TIE-4: onboarded_at desc, NULLS LAST
    const oa = a.tec.onboarded_at ? Date.parse(a.tec.onboarded_at) : -Infinity;
    const ob = b.tec.onboarded_at ? Date.parse(b.tec.onboarded_at) : -Infinity;
    if (ob !== oa) return ob - oa;
    // TIE-5: tecnico_id asc (deterministic)
    return a.tec.tecnico_id.localeCompare(b.tec.tecnico_id);
  });

  // 6. Truncate to limit.
  const top = scored.slice(0, limit);

  // 7. Compose Spanish reasons per candidate. Priority: fit, prox, calidad, experiencia.
  const ranked: RankedTecnico[] = top.map((s) => {
    const reasons: string[] = [];

    // ---- Fit reason ----
    if (s.score_fit === 1.0) {
      reasons.push(
        alcance?.subcategoria
          ? `Especialidad exacta (${alcance.subcategoria})`
          : "Especialidad exacta"
      );
    } else if (s.score_fit === 0.7) {
      reasons.push("Especialidad coincide en categoría");
    } else if (s.score_fit === 0.4) {
      reasons.push("Especialidad relacionada");
    } else if (s.score_fit === 0 && resolvedEspec === null) {
      reasons.push("Sin especialidad declarada en la OT — match por ciudad");
    } else {
      // score_fit === 0 and ot has a declared especialidad
      reasons.push("Sin overlap de especialidad");
    }

    // ---- Proximidad reason ----
    if (s.score_proximidad === 1.0) {
      reasons.push(`Misma ciudad: ${s.profile.ciudad ?? ""}`.trim());
    } else if (s.profile.ciudad) {
      reasons.push(`Otra ciudad: ${s.profile.ciudad}`);
    }

    // ---- Calidad reason ----
    if (s.eval_count > 0 && s.score_calidad !== null) {
      const stars = s.score_calidad.toFixed(1);
      const trabajos = `${s.eval_count} trabajo${s.eval_count === 1 ? "" : "s"}`;
      reasons.push(`Calificación ${stars}⭐ en ${trabajos}`);
    } else {
      reasons.push("Sin calificaciones aún");
    }

    // ---- Experiencia reason ----
    if (s.anos_experiencia !== null) {
      const a = s.anos_experiencia;
      reasons.push(`${a} año${a === 1 ? "" : "s"} de experiencia`);
    }

    // Cap to 4 reasons (priority order already applied).
    const capped = reasons.slice(0, 4);

    return {
      tecnico_id: s.tec.tecnico_id,
      nombre: s.tec.nombre ?? "",
      ciudad: s.profile.ciudad,
      especialidades: s.profile.especialidades,
      score_fit: s.score_fit,
      score_proximidad: s.score_proximidad,
      score_calidad: s.score_calidad,
      eval_count: s.eval_count,
      anos_experiencia: s.anos_experiencia,
      reasons: capped,
    };
  });

  return {
    ot_row_id: otRowId,
    ot_ciudad: otCiudad,
    ot_especialidad,
    alcance_source: alcanceSource,
    total_approved,
    ranked,
  };
}
