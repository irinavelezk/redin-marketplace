// recommend_shortlist_candidate — single Anthropic call to pick the best
// candidate for a given OT.
//
// Design constraints (from sprint spec):
//   - Single Anthropic call: claude-haiku-4-5, temp 0, max_tokens 256.
//   - Forced tool_use via tool_choice: { type:"tool", name:"pick_one" }.
//   - Cache by (ot_id, pool_hash). pool_hash = sha256 of sorted postulacion_ids
//     in state='postulado'. Rec recomputed only when pool changes.
//   - Upserts candidate_decisions (scope='shortlist', ot_id) with rec fields.
//   - Logs shortlist_recommendation_generated event.
//   - No agent loop — one shot.
//
// NOTE: The ranking logic here is a local copy of the signal computation from
// dashboard/src/lib/ranking.ts. At integration time (when Stream C changes the
// ranking signature), update both. The tool avoids a cross-workspace import on
// purpose (tools/ must not depend on dashboard/).

import Anthropic from "@anthropic-ai/sdk";
import { createHash } from "crypto";
import type { ToolContext } from "./context";
import type { ToolResult } from "./types";
import { ok, err } from "./types";
import type { Json } from "@redin/shared";

// ---- Output types ----

export interface RecommendShortlistInput {
  ot_id: string;
}

export interface RecommendShortlistOutput {
  recommended_postulacion_id: string;
  confidence: number;
  reasoning: string;
  pool_hash: string;
  /** true when the result came from cache (pool_hash unchanged) */
  cached: boolean;
}

// ---- pick_one tool schema (forced structured output) ----

const PICK_ONE_TOOL: Anthropic.Tool = {
  name: "pick_one",
  description:
    "Recomienda el mejor candidato para esta OT y explica brevemente.",
  input_schema: {
    type: "object",
    properties: {
      recommended_postulacion_id: {
        type: "string",
        description: "UUID of the postulacion being recommended.",
      },
      confidence: {
        type: "number",
        description: "Confidence in the recommendation, 0.0 to 1.0.",
      },
      reasoning: {
        type: "string",
        description:
          "Una frase en español explicando por qué. Máximo 140 caracteres.",
      },
    },
    required: ["recommended_postulacion_id", "confidence", "reasoning"],
  } as Anthropic.Tool["input_schema"],
};

// ---- Ranking helpers (local copy — keep in sync with dashboard/src/lib/ranking.ts) ----

interface PostulacionLike {
  id: string;
  tecnico_id: string;
  applied_at: string;
}

interface CandidateScore {
  postulacion_id: string;
  tecnico_id: string;
  disponibilidad: number;
  calidad: number | null;
}

const MAX_OPEN_POS_PENALTY = 3;
const FRESH_WINDOW_MS = 24 * 3600 * 1000 * 7; // 1 week

function scoreCandidate(
  p: PostulacionLike,
  openPosByTecnico: Map<string, number>,
  ratingByTecnico: Map<string, number | null>
): CandidateScore {
  const now = Date.now();
  const applied = new Date(p.applied_at).getTime();
  const ageMs = now - applied;
  const freshness = Math.max(0, 1 - Math.min(ageMs / FRESH_WINDOW_MS, 1));
  const openCount = openPosByTecnico.get(p.tecnico_id) ?? 0;
  const loadPenalty = Math.min(openCount / MAX_OPEN_POS_PENALTY, 1);
  const disponibilidad = Math.max(0, freshness * (1 - loadPenalty));
  const calidad = ratingByTecnico.get(p.tecnico_id) ?? null;
  return { postulacion_id: p.id, tecnico_id: p.tecnico_id, disponibilidad, calidad };
}

function rankCandidates(
  posts: PostulacionLike[],
  openPosByTecnico: Map<string, number>,
  ratingByTecnico: Map<string, number | null>
): CandidateScore[] {
  const scored = posts.map((p) => scoreCandidate(p, openPosByTecnico, ratingByTecnico));
  scored.sort((a, b) => {
    if (b.disponibilidad !== a.disponibilidad) return b.disponibilidad - a.disponibilidad;
    const qa = a.calidad ?? -1;
    const qb = b.calidad ?? -1;
    return qb - qa;
  });
  return scored;
}

// ---- Other helpers ----

function computePoolHash(postulacionIds: string[]): string {
  const sorted = [...postulacionIds].sort().join(",");
  return createHash("sha256").update(sorted).digest("hex").slice(0, 16);
}

function buildSystemPrompt(): string {
  return `Eres Toño, el asistente de selección de Redin.
Tu tarea: dado un listado de candidatos para una orden de trabajo (OT), elige UNO.
Basa tu decisión en: disponibilidad (freshness + carga), calidad (calificación promedio) y adecuación al perfil de la OT.
Responde SOLO usando la herramienta pick_one. No generes texto libre.`;
}

function buildUserPrompt(
  otDesc: string,
  otCiudad: string | null,
  otEspecialidad: string | null,
  candidates: {
    postulacion_id: string;
    nombre: string | null;
    ciudad: string | null;
    disponibilidad: number;
    calidad: number | null;
  }[]
): string {
  const lines: string[] = [
    `OT: ${otDesc} | Ciudad: ${otCiudad ?? "?"} | Especialidad: ${otEspecialidad ?? "?"}`,
    "",
    "Candidatos (postulacion_id | nombre | ciudad | disponibilidad 0-1 | calidad 1-5 o null):",
  ];
  for (const c of candidates) {
    lines.push(
      `- ${c.postulacion_id} | ${c.nombre ?? "sin nombre"} | ${c.ciudad ?? "?"} | dispo=${c.disponibilidad.toFixed(2)} | cal=${c.calidad?.toFixed(1) ?? "null"}`
    );
  }
  lines.push("", "Elige el mejor candidato. Si hay empate, prefiere mayor disponibilidad.");
  return lines.join("\n");
}

function descripcionFrom(data: Json): string {
  if (!data || typeof data !== "object" || Array.isArray(data)) return "";
  const d = data as Record<string, unknown>;
  for (const k of ["Descripcion", "descripcion", "Resumen Visual", "Actividad_Descripcion"]) {
    const v = d[k];
    if (typeof v === "string" && v.trim()) return v.trim().slice(0, 120);
  }
  return "";
}

// ---- Anthropic client singleton ----

let _anthropic: Anthropic | null = null;
function getAnthropic(): Anthropic {
  if (_anthropic) return _anthropic;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");
  _anthropic = new Anthropic({ apiKey, maxRetries: 0 });
  return _anthropic;
}

// ---- Main function ----

export async function recommendShortlistCandidate(
  ctx: ToolContext,
  input: RecommendShortlistInput
): Promise<ToolResult<RecommendShortlistOutput>> {
  const { ot_id } = input;

  // 1. Load OT
  const { data: ot, error: otErr } = await ctx.supabase
    .from("ots_mirror")
    .select("row_id, ciudad, especialidad, data")
    .eq("row_id", ot_id)
    .maybeSingle();
  if (otErr) return err(`db error: ${otErr.message}`, { code: "db_error" });
  if (!ot) return err("OT not found", { code: "not_found" });

  // 2. Load postulaciones in state='postulado'
  const { data: posts, error: postsErr } = await ctx.supabase
    .from("postulaciones")
    .select("id, tecnico_id, state, applied_at")
    .eq("ot_id", ot_id)
    .eq("state", "postulado");
  if (postsErr) return err(`db error: ${postsErr.message}`, { code: "db_error" });
  if (!posts || posts.length === 0) {
    return err("No postulaciones in state postulado", { code: "no_candidates" });
  }

  // 3. Compute pool hash
  const poolHash = computePoolHash(posts.map((p) => p.id));

  // 4. Check cache: existing candidate_decisions row for (ot_id, scope='shortlist')
  const { data: existingRec } = await ctx.supabase
    .from("candidate_decisions")
    .select(
      "id, pool_hash, tono_recommendation_postulacion_id, tono_confidence, tono_reasoning"
    )
    .eq("ot_id", ot_id)
    .eq("scope", "shortlist" as "shortlist")
    .maybeSingle();

  if (
    existingRec &&
    existingRec.pool_hash === poolHash &&
    existingRec.tono_recommendation_postulacion_id
  ) {
    // Cache hit — return persisted rec
    return ok({
      recommended_postulacion_id: existingRec.tono_recommendation_postulacion_id,
      confidence: (existingRec.tono_confidence as number | null) ?? 0,
      reasoning: (existingRec.tono_reasoning as string | null) ?? "",
      pool_hash: poolHash,
      cached: true,
    });
  }

  // 5. Load worker performance + open postulaciones for ranking
  const tecnicoIds = [...new Set(posts.map((p) => p.tecnico_id))];

  const [perfRes, openPosRes, tecRes, ciudadEventsRes] = await Promise.all([
    tecnicoIds.length
      ? ctx.supabase
          .from("tecnico_performance")
          .select("tecnico_id, avg_score, eval_count")
          .in("tecnico_id", tecnicoIds)
      : Promise.resolve({ data: [] as Array<{ tecnico_id: string; avg_score: number | null; eval_count: number }> }),
    tecnicoIds.length
      ? ctx.supabase
          .from("postulaciones")
          .select("tecnico_id, state")
          .in("tecnico_id", tecnicoIds)
          .in("state", ["postulado", "preseleccionado"])
      : Promise.resolve({ data: [] as Array<{ tecnico_id: string; state: string }> }),
    tecnicoIds.length
      ? ctx.supabase
          .from("tecnicos_extended")
          .select("tecnico_id, nombre")
          .in("tecnico_id", tecnicoIds)
      : Promise.resolve({ data: [] as Array<{ tecnico_id: string; nombre: string | null }> }),
    tecnicoIds.length
      ? ctx.supabase
          .from("eventos")
          .select("entity_id, meta")
          .eq("type", "tecnico_registered")
          .in("entity_id", tecnicoIds)
          .order("created_at", { ascending: false })
      : Promise.resolve({ data: [] as Array<{ entity_id: string | null; meta: Json | null }> }),
  ]);

  const ratingByTec = new Map<string, number | null>();
  for (const id of tecnicoIds) ratingByTec.set(id, null);
  for (const r of perfRes.data ?? []) {
    const row = r as { tecnico_id: string; avg_score: number | null; eval_count: number };
    ratingByTec.set(
      row.tecnico_id,
      row.eval_count > 0 && row.avg_score !== null ? row.avg_score : null
    );
  }

  const openPosByTec = new Map<string, number>();
  for (const r of openPosRes.data ?? []) {
    const row = r as { tecnico_id: string; state: string };
    openPosByTec.set(row.tecnico_id, (openPosByTec.get(row.tecnico_id) ?? 0) + 1);
  }

  const nombreByTec = new Map<string, string | null>();
  for (const r of tecRes.data ?? []) {
    const row = r as { tecnico_id: string; nombre: string | null };
    nombreByTec.set(row.tecnico_id, row.nombre ?? null);
  }

  const ciudadByTec = new Map<string, string | null>();
  for (const e of ciudadEventsRes.data ?? []) {
    const ev = e as { entity_id: string | null; meta: Json | null };
    if (!ev.entity_id || ciudadByTec.has(ev.entity_id)) continue;
    const m = ev.meta as Record<string, unknown> | null;
    ciudadByTec.set(ev.entity_id, typeof m?.ciudad === "string" ? m.ciudad : null);
  }

  // 6. Rank candidates
  const ranked = rankCandidates(posts, openPosByTec, ratingByTec);

  // 7. Build LLM prompt
  const otDesc = descripcionFrom(ot.data);
  const candidates = ranked.map((r) => ({
    postulacion_id: r.postulacion_id,
    nombre: nombreByTec.get(r.tecnico_id) ?? null,
    ciudad: ciudadByTec.get(r.tecnico_id) ?? null,
    disponibilidad: r.disponibilidad,
    calidad: r.calidad,
  }));

  // 8. Single Anthropic call — forced tool_use
  const anthropic = getAnthropic();
  let llmResult: { id: string; confidence: number; reasoning: string };
  try {
    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 256,
      temperature: 0,
      system: buildSystemPrompt(),
      tools: [PICK_ONE_TOOL],
      tool_choice: { type: "tool", name: "pick_one" },
      messages: [
        {
          role: "user",
          content: buildUserPrompt(otDesc, ot.ciudad, ot.especialidad, candidates),
        },
      ],
    });

    const toolBlock = response.content.find(
      (b): b is Anthropic.ToolUseBlock =>
        b.type === "tool_use" && b.name === "pick_one"
    );
    if (!toolBlock) {
      return err("LLM did not return pick_one tool use", { code: "llm_no_tool" });
    }

    const raw = toolBlock.input as {
      recommended_postulacion_id: string;
      confidence: number;
      reasoning: string;
    };

    // Validate the returned postulacion_id is in our pool
    const validIds = new Set(posts.map((p) => p.id));
    if (!validIds.has(raw.recommended_postulacion_id)) {
      // Fallback: use the top-ranked candidate if LLM hallucinated an id
      const fallbackId = ranked[0]?.postulacion_id;
      if (!fallbackId) {
        return err(`LLM returned invalid postulacion_id and no fallback`, {
          code: "llm_invalid_id",
        });
      }
      llmResult = {
        id: fallbackId,
        confidence: 0.5,
        reasoning: "Recomendado por disponibilidad (id inválido del modelo corregido).",
      };
    } else {
      llmResult = {
        id: raw.recommended_postulacion_id,
        confidence: Math.max(0, Math.min(1, raw.confidence ?? 0)),
        reasoning: (raw.reasoning ?? "").slice(0, 140),
      };
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return err(`Anthropic call failed: ${msg}`, { code: "llm_error", retryable: true });
  }

  // 9. Upsert candidate_decisions (scope='shortlist', ot_id)
  const nowIso = new Date().toISOString();

  if (existingRec) {
    // Update existing row with new rec
    await ctx.supabase
      .from("candidate_decisions")
      .update({
        tono_recommendation_postulacion_id: llmResult.id,
        tono_confidence: llmResult.confidence,
        tono_reasoning: llmResult.reasoning,
        pool_hash: poolHash,
        decided_at: nowIso,
      })
      .eq("id", existingRec.id);
  } else {
    // Insert new shortlist row.
    // Migration 012 makes tecnico_id nullable for shortlist scope.
    // decision / resulting_state / prior_state are required by existing constraints;
    // we use valid placeholder values since they are meaningless for shortlist rows.
    await ctx.supabase.from("candidate_decisions").insert({
      tecnico_id: null,
      decision: "approve",
      resulting_state: "approved",
      prior_state: "pending",
      decided_by: "agent",
      scope: "shortlist",
      ot_id,
      tono_recommendation_postulacion_id: llmResult.id,
      tono_confidence: llmResult.confidence,
      tono_reasoning: llmResult.reasoning,
      pool_hash: poolHash,
      decided_at: nowIso,
    });
  }

  // 10. Log event
  await ctx.supabase.from("eventos").insert({
    type: "shortlist_recommendation_generated",
    entity_id: ot_id,
    actor: "agent",
    meta: {
      ot_id,
      recommended_postulacion_id: llmResult.id,
      confidence: llmResult.confidence,
      pool_hash: poolHash,
      candidate_count: posts.length,
    },
  });

  return ok({
    recommended_postulacion_id: llmResult.id,
    confidence: llmResult.confidence,
    reasoning: llmResult.reasoning,
    pool_hash: poolHash,
    cached: false,
  });
}
