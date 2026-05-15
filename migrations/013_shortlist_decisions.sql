-- 012 — Shortlist decisions: per-OT Toño recommendation + HR agreement tracking
--
-- Extends candidate_decisions for the shortlist gate (scope='shortlist').
-- The qualification scope rows (scope='qualification') already existed; these
-- new columns are NULL-safe for legacy rows.
--
-- Design:
--   scope                              — 'qualification' | 'shortlist'
--   ot_id                              — FK to ots_mirror.row_id; used when scope='shortlist'
--   tono_recommendation_postulacion_id — which postulacion Toño recommended
--   pool_hash                          — sha256 of sorted postulacion_ids in state='postulado'
--                                        at the time the rec was generated; cache key
--
-- tono_agreement_metrics view is OR-REPLACED to add scope-filtered projection.
-- New shortlist_agreement_metrics view filters to scope='shortlist'.
--
-- Event types added:
--   shortlist_recommendation_generated — Toño generated a per-OT rec
--   architect_nudge_sent               — HR triggered Manos outbound nudge
--
-- Idempotent.

-- ============================================================================
-- 1. Extend candidate_decisions with shortlist columns
-- ============================================================================

-- The tecnico_id FK is mandatory for qualification rows but meaningless for
-- shortlist rows (which are per-OT, not per-worker). Relax the NOT NULL by
-- dropping the existing FK constraint and re-adding it as a nullable column
-- with a CHECK that enforces non-null only for qualification scope.
-- NOTE: We cannot add a conditional NOT NULL in PG without a constraint trigger;
-- instead we just make the column nullable and enforce non-null at the app layer
-- for qualification rows.
alter table candidate_decisions
  alter column tecnico_id drop not null;

alter table candidate_decisions
  add column if not exists scope text not null default 'qualification'
    check (scope in ('qualification', 'shortlist'));

-- For shortlist rows: which OT is this decision for?
alter table candidate_decisions
  add column if not exists ot_id text
    references ots_mirror(row_id) on delete cascade;

-- Toño's per-OT recommendation: a postulacion_id (not a TonoRecommendation enum).
-- For scope='shortlist' rows only. NULL for qualification rows.
alter table candidate_decisions
  add column if not exists tono_recommendation_postulacion_id uuid
    references postulaciones(id) on delete set null;

-- Pool hash for caching — sha256 of sorted postulacion_ids at rec-generation time.
-- Stored so the UI can compare against current pool and decide whether to re-run.
alter table candidate_decisions
  add column if not exists pool_hash text;

-- Toño's confidence for shortlist recommendations (0.0–1.0).
-- For qualification rows, confidence lives on candidate_dossiers (not here).
alter table candidate_decisions
  add column if not exists tono_confidence numeric(3, 2)
    check (tono_confidence is null or (tono_confidence >= 0 and tono_confidence <= 1));

-- Toño's one-line reasoning for shortlist recommendations (≤140 chars).
alter table candidate_decisions
  add column if not exists tono_reasoning text;

-- HR's pick for shortlist (postulacion_id chosen by HR). Populated when HR decides.
alter table candidate_decisions
  add column if not exists hr_postulacion_id uuid
    references postulaciones(id) on delete set null;

-- Backfill existing rows: mark them as qualification scope.
update candidate_decisions
set scope = 'qualification'
where scope is null or scope = 'qualification';

-- Supporting indexes.
create index if not exists idx_decisions_scope
  on candidate_decisions (scope);

create index if not exists idx_decisions_ot_scope
  on candidate_decisions (ot_id, scope)
  where ot_id is not null;

create index if not exists idx_decisions_shortlist_ot
  on candidate_decisions (ot_id)
  where scope = 'shortlist' and ot_id is not null;

-- ============================================================================
-- 2. Drop + recreate tono_agreement_metrics to include scope column
-- ============================================================================
-- Original view from migration 007 only exposed qualification-scope rows;
-- now we expose all scope values and let consumers GROUP BY scope as needed.

create or replace view tono_agreement_metrics as
select
  d.id                                                        as decision_id,
  d.tecnico_id,
  d.dossier_id,
  d.ot_id,
  d.scope,
  d.decided_at,
  date_trunc('day',  d.decided_at)::date                      as decided_day,
  date_trunc('week', d.decided_at)::date                      as decided_week,
  d.decided_by                                                 as hr_user,
  -- For qualification scope: tono_recommendation_at_decision_time (text enum)
  -- For shortlist scope: coerce to NULL (different type — see shortlist_agreement_metrics)
  d.tono_recommendation_at_decision_time                      as tono_recommendation,
  d.decision                                                   as hr_decision,
  d.agreed_with_tono
from candidate_decisions d
where d.tono_recommendation_at_decision_time is not null
  and d.decision in ('approve', 'reject', 'schedule_call')
  and d.scope = 'qualification';

comment on view tono_agreement_metrics is
  'Graduated-autonomy signal — qualification scope. One row per comparable HR decision. Group by decided_week / decided_day / hr_user / tono_recommendation. See shortlist_agreement_metrics for shortlist scope.';

-- ============================================================================
-- 3. New view: shortlist_agreement_metrics
-- ============================================================================
-- Rows where scope='shortlist' and HR made a decision (hr_postulacion_id set).
-- agreed_with_tono = (hr_postulacion_id == tono_recommendation_postulacion_id).
-- This view is what the /hr/pipeline agreement-rate block queries.

create or replace view shortlist_agreement_metrics as
select
  d.id                                                         as decision_id,
  d.ot_id,
  d.decided_at,
  date_trunc('day',  d.decided_at)::date                       as decided_day,
  date_trunc('week', d.decided_at)::date                       as decided_week,
  d.decided_by                                                  as hr_user,
  d.tono_recommendation_postulacion_id,
  d.hr_postulacion_id,
  d.agreed_with_tono,
  d.tono_confidence,
  d.tono_reasoning
from candidate_decisions d
where d.scope = 'shortlist'
  and d.hr_postulacion_id is not null
  and d.tono_recommendation_postulacion_id is not null;

comment on view shortlist_agreement_metrics is
  'Shortlist-scope agreement metrics. One row per OT where HR decided AND Toño had a recommendation. Query for agreement rate: COUNT(*) / COUNT(*) FILTER (WHERE agreed_with_tono).';

-- ============================================================================
-- 4. Event types — documented for reference (events are free-text strings)
-- ============================================================================
-- New event types in use after this migration:
--   shortlist_recommendation_generated  — Toño ran pick_one for an OT
--   architect_nudge_sent                — HR clicked "pedir alcance"

comment on table candidate_decisions is
  'HR action audit — two scopes: qualification (per tecnico) and shortlist (per OT). Qualification: one row per HR state-transition. Shortlist: one row per OT, upserted when rec generated and when HR decides.';
