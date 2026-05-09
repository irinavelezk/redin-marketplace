-- 010 — First-class `nombre` column on tecnicos_extended
--
-- Closes defects D1, D2, D3, D8 from the 2026-05-08 E2E test (Manuel screening):
--   - HR sees worker names everywhere (qualification queue, pipeline, shortlist)
--     instead of `tecnico_id.slice(0, 8)` hash prefixes.
--   - Projector reads `nombre` directly from the row instead of querying the
--     latest `tecnico_registered` event per worker. (Event lookup remains as
--     fallback for legacy rows whose backfill source is missing.)
--   - register_tecnico writes `nombre` to the column on insert and on
--     re-registration (when the existing row's nombre is NULL).
--
-- Until this migration, names lived only in `eventos.meta.nombre` (from the
-- `tecnico_registered` event, or `tecnico_legacy_bootstrap` for AppSheet
-- imports) and every consumer re-derived. Migrations 001–009 deliberately
-- avoided naming columns; phase 0 of the post-pilot cleanup adds it as a
-- plain informational text — nullable, no DEFAULT, no CHECK — because legacy
-- rows without an event would otherwise need synthetic placeholder values.
--
-- Companion to no other migration. Idempotent.

alter table tecnicos_extended
  add column if not exists nombre text;

-- Backfill from the most recent `tecnico_registered` event per tecnico_id.
-- DISTINCT ON keeps the latest row when multiple registrations exist for the
-- same entity. Empty / whitespace-only values are coerced to NULL via NULLIF.
update tecnicos_extended te
set nombre = e.nombre
from (
  select distinct on (entity_id)
    entity_id,
    nullif(trim(meta->>'nombre'), '') as nombre
  from eventos
  where type = 'tecnico_registered'
    and meta ? 'nombre'
  order by entity_id, created_at desc
) e
where te.tecnico_id = e.entity_id
  and te.nombre is null
  and e.nombre is not null;

-- Fallback: legacy AppSheet imports leave their nombre in
-- `tecnico_legacy_bootstrap` (see scripts/import-legacy-tecnicos.ts), not in
-- `tecnico_registered`. Same shape, same NULLIF guard.
update tecnicos_extended te
set nombre = e.nombre
from (
  select distinct on (entity_id)
    entity_id,
    nullif(trim(meta->>'nombre'), '') as nombre
  from eventos
  where type = 'tecnico_legacy_bootstrap'
    and meta ? 'nombre'
  order by entity_id, created_at desc
) e
where te.tecnico_id = e.entity_id
  and te.nombre is null
  and e.nombre is not null;

comment on column tecnicos_extended.nombre is
  'Worker display name as captured at registration. Single string; first name + apellidos when Toño asks for nombre completo. NULL on legacy rows whose source event was never written. Authoritative for HR display; eventos.meta.nombre stays as a defense-in-depth fallback for the projector.';
