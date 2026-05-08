// complete_legacy_profile — progressive enrichment of an approved + incomplete
// legacy worker (CASE A in the agent's three-case routing).
//
// Behavior:
//   - Merges {profile_data} into tecnicos_extended.enrichment_data (jsonb).
//   - If profile_data.cedula is given, writes it to the dedicated cedula column
//     (gated by the partial UNIQUE index). NULL preserved if not provided.
//   - Recomputes profile_complete: true iff cedula + ciudad_base + >=1
//     categoria_principal are populated AFTER the merge.
//   - Does NOT create a candidate_dossiers row. Does NOT trigger HR review.
//   - candidate_state stays 'approved' regardless.
//
// Idempotent: passing the same fields twice is a no-op.
// Refuses if the row is not in (approved, profile_complete=false): worker is
// either still screening (use submit_candidate_dossier) or already enriched
// (CASE C — nothing to do).

import type { ToolContext } from "./context";
import type { Json } from "@redin/shared";
import { ok, err, type ToolResult } from "./types";
import { recordEvent } from "./events";
import {
  CIUDAD_CANONICAL,
  CATEGORIA_VALUES,
  type CiudadCanonical,
  type Categoria,
  type TipoCedula,
} from "@redin/shared/dossier-types";

const CIUDAD_SET = new Set<string>(CIUDAD_CANONICAL);
const CATEGORIA_SET = new Set<string>(CATEGORIA_VALUES);

export interface LegacyEnrichmentData {
  cedula?: { tipo: TipoCedula; numero: string };
  modalidad?: "individual" | "cuadrilla" | "lider";
  ciudad_base?: CiudadCanonical;
  ciudades_cobertura?: CiudadCanonical[];
  categorias_principales?: Categoria[];
  subcategorias?: string[];
  anos_experiencia?: number;
  certificaciones?: {
    altura?: boolean;
    altura_avanzado?: boolean;
    retie?: boolean;
    andamios?: boolean;
    soldadura?: boolean;
    conte?: boolean;
    otras?: string;
  };
  herramientas?: {
    basicas?: boolean;
    electrica_obra?: boolean;
    electrica_medicion?: boolean;
    altura_personal?: boolean;
    andamio_propio?: boolean;
    vehiculo_propio?: boolean;
  };
  disponibilidad?: {
    inicio_inmediato?: boolean;
    fines_de_semana?: boolean;
    nocturno?: boolean;
    viaja_otra_ciudad?: boolean;
    ciudades_viaje?: CiudadCanonical[];
  };
  cumplimiento?: {
    arl_activa?: boolean;
    arl_fondo?: string;
    eps_activa?: boolean;
    antecedentes_limpios?: boolean | null;
  };
  notas?: string;
}

export interface CompleteLegacyProfileInput {
  tecnico_id: string;
  profile_data: LegacyEnrichmentData;
}

export interface CompleteLegacyProfileOutput {
  tecnico_id: string;
  profile_complete: boolean;
  fields_added: string[];
  fields_unchanged: string[];
  noop: boolean;
}

function normalizeCedula(raw: string): string {
  return raw.replace(/[^\d]/g, "");
}

export async function completeLegacyProfile(
  ctx: ToolContext,
  input: CompleteLegacyProfileInput
): Promise<ToolResult<CompleteLegacyProfileOutput>> {
  if (!input.tecnico_id?.trim()) {
    return err("tecnico_id required", { code: "invalid_input" });
  }
  if (!input.profile_data || typeof input.profile_data !== "object") {
    return err("profile_data must be an object", { code: "invalid_input" });
  }

  const { data: tec, error: lookupErr } = await ctx.supabase
    .from("tecnicos_extended")
    .select(
      "tecnico_id, candidate_state, profile_complete, cedula, enrichment_data, import_source"
    )
    .eq("tecnico_id", input.tecnico_id)
    .maybeSingle();
  if (lookupErr) {
    return err(`db error: ${lookupErr.message}`, {
      code: "db_error",
      retryable: true,
    });
  }
  if (!tec) return err("tecnico_id not found", { code: "not_found" });

  if (tec.candidate_state !== "approved") {
    return err(
      `tecnico is in state '${tec.candidate_state}', not 'approved' — use submit_candidate_dossier instead`,
      { code: "wrong_state" }
    );
  }
  if (tec.profile_complete) {
    // CASE C territory — already complete. Idempotent no-op.
    return ok({
      tecnico_id: tec.tecnico_id,
      profile_complete: true,
      fields_added: [],
      fields_unchanged: [],
      noop: true,
    });
  }

  const incoming = input.profile_data;
  const fieldsAdded: string[] = [];
  const fieldsUnchanged: string[] = [];

  const existingEnrichment =
    (tec.enrichment_data as LegacyEnrichmentData | null) ?? {};
  const merged: Record<string, unknown> = { ...existingEnrichment };

  // Validate + merge each field. Reject hard on out-of-vocabulary canonical
  // values; the agent must speak the contract's vocabulary.
  let cedulaToWrite: string | null = null;
  if (incoming.cedula && typeof incoming.cedula === "object") {
    const tipo = incoming.cedula.tipo;
    const numeroRaw = incoming.cedula.numero ?? "";
    const numero = normalizeCedula(numeroRaw);
    if (!["CC", "CE", "PEP"].includes(tipo)) {
      return err(`cedula.tipo invalid: ${tipo}`, { code: "invalid_input" });
    }
    if (numero.length < 5 || numero.length > 11) {
      return err("cedula.numero must be 5-11 digits", {
        code: "invalid_input",
      });
    }
    if (tec.cedula && tec.cedula !== numero) {
      return err(
        `cedula already set on this row to a different value`,
        { code: "cedula_conflict" }
      );
    }
    if (!tec.cedula) {
      cedulaToWrite = numero;
      fieldsAdded.push("cedula");
    } else {
      fieldsUnchanged.push("cedula");
    }
    merged.cedula = { tipo, numero };
  }

  if (incoming.ciudad_base) {
    if (!CIUDAD_SET.has(incoming.ciudad_base)) {
      return err(
        `ciudad_base must be one of: ${[...CIUDAD_CANONICAL].slice(0, 6).join(", ")}, …`,
        { code: "invalid_input" }
      );
    }
    if (existingEnrichment.ciudad_base !== incoming.ciudad_base) {
      fieldsAdded.push("ciudad_base");
    } else {
      fieldsUnchanged.push("ciudad_base");
    }
    merged.ciudad_base = incoming.ciudad_base;
  }

  if (incoming.categorias_principales) {
    if (
      !Array.isArray(incoming.categorias_principales) ||
      incoming.categorias_principales.length === 0
    ) {
      return err(
        "categorias_principales must be a non-empty array",
        { code: "invalid_input" }
      );
    }
    const bad = incoming.categorias_principales.find(
      (c) => !CATEGORIA_SET.has(c)
    );
    if (bad) {
      return err(`unknown categoria: ${bad}`, { code: "invalid_input" });
    }
    const prior = JSON.stringify(existingEnrichment.categorias_principales ?? []);
    const next = JSON.stringify(incoming.categorias_principales);
    if (prior !== next) fieldsAdded.push("categorias_principales");
    else fieldsUnchanged.push("categorias_principales");
    merged.categorias_principales = incoming.categorias_principales;
  }

  // Best-effort merge for other optional fields. Agent may pass any subset.
  for (const key of [
    "modalidad",
    "ciudades_cobertura",
    "subcategorias",
    "anos_experiencia",
    "certificaciones",
    "herramientas",
    "disponibilidad",
    "cumplimiento",
    "notas",
  ] as const) {
    const v = (incoming as Record<string, unknown>)[key];
    if (v === undefined) continue;
    const prior = JSON.stringify(
      (existingEnrichment as Record<string, unknown>)[key] ?? null
    );
    const next = JSON.stringify(v);
    if (prior !== next) fieldsAdded.push(key);
    else fieldsUnchanged.push(key);
    merged[key] = v;
  }

  // Compute profile_complete after merge.
  const finalCedula = cedulaToWrite ?? tec.cedula;
  const finalCiudad = merged.ciudad_base as string | undefined;
  const finalCategorias = merged.categorias_principales as
    | string[]
    | undefined;
  const computedComplete =
    !!finalCedula &&
    !!finalCiudad &&
    Array.isArray(finalCategorias) &&
    finalCategorias.length >= 1;

  if (fieldsAdded.length === 0 && computedComplete === tec.profile_complete) {
    // Truly nothing changed.
    return ok({
      tecnico_id: tec.tecnico_id,
      profile_complete: tec.profile_complete,
      fields_added: [],
      fields_unchanged: fieldsUnchanged,
      noop: true,
    });
  }

  const patch: Partial<{
    enrichment_data: Json;
    profile_complete: boolean;
    cedula: string;
  }> = {
    enrichment_data: merged as Json,
    profile_complete: computedComplete,
  };
  if (cedulaToWrite) patch.cedula = cedulaToWrite;

  const { error: updateErr } = await ctx.supabase
    .from("tecnicos_extended")
    .update(patch)
    .eq("tecnico_id", tec.tecnico_id);
  if (updateErr) {
    return err(`update failed: ${updateErr.message}`, {
      code: "db_error",
      retryable: true,
    });
  }

  await recordEvent(ctx, {
    type: "tecnico_legacy_enriched",
    entity_id: tec.tecnico_id,
    actor: ctx.defaultActor,
    meta: {
      fields_added: fieldsAdded,
      profile_complete: computedComplete,
    },
  });

  return ok({
    tecnico_id: tec.tecnico_id,
    profile_complete: computedComplete,
    fields_added: fieldsAdded,
    fields_unchanged: fieldsUnchanged,
    noop: false,
  });
}
