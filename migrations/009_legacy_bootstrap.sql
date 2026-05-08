-- 009 — Legacy worker bootstrap + progressive enrichment + dynamic AppSheet capture
--
-- Adds the columns scripts/import-legacy-tecnicos.ts writes (imported_at,
-- import_source, profile_complete, legacy_popularidad, legacy_activity_count)
-- and the JSONB column complete_legacy_profile writes (enrichment_data).
--
-- Companion to 007: 007 establishes the 7-state machine and cedula identity;
-- 009 layers in the legacy-trust path so the ~49 pre-existing AppSheet
-- workers can be reachable by Toño without re-screening.
--
-- Routing rule (agent.ts): a row with candidate_state='approved' AND
-- profile_complete=false is in CASE A (enrichment); approved + complete is
-- CASE C (returning); anything else is CASE B (standard screening).
--
-- Idempotent. Every DDL guarded by IF NOT EXISTS.

alter table tecnicos_extended
  add column if not exists imported_at timestamptz,
  add column if not exists import_source text,
  add column if not exists profile_complete boolean not null default false,
  add column if not exists legacy_popularidad int,
  add column if not exists legacy_activity_count int,
  add column if not exists enrichment_data jsonb;

-- Routing lookup: agent.ts reads (candidate_state, profile_complete) on every
-- inbound. Composite index keeps that on a btree scan.
create index if not exists idx_tecnicos_extended_routing
  on tecnicos_extended (candidate_state, profile_complete);

-- High-trust legacy surfacing (>=5 historical actividades). Partial so it
-- stays small and only matters for the high-priority slice.
create index if not exists idx_tecnicos_extended_legacy_popularidad
  on tecnicos_extended (legacy_popularidad desc)
  where legacy_popularidad >= 5;

comment on column tecnicos_extended.imported_at is
  'When the row was first written by scripts/import-legacy-tecnicos.ts. NULL for screening-born rows.';
comment on column tecnicos_extended.import_source is
  '"appsheet_legacy_bootstrap" for legacy imports. NULL for screening-born rows.';
comment on column tecnicos_extended.profile_complete is
  'true once cedula + ciudad_base + >=1 categoria_principal are captured (computed by complete_legacy_profile). Drives Toño routing CASE A vs CASE C.';
comment on column tecnicos_extended.legacy_popularidad is
  'AppSheet Popularidad_Tecnico at import time. Trust signal for matching priority. Workers >= 5 surface first.';
comment on column tecnicos_extended.legacy_activity_count is
  'Count of items in AppSheet "Related DETALLE DE ACTIVIDADESs" at import time. Mirrors legacy_popularidad in practice; stored as a queryable column.';
comment on column tecnicos_extended.enrichment_data is
  'Progressive-enrichment payload from complete_legacy_profile. Schema mirrors CandidateDossier minus the recommendation triplet. All fields optional.';
