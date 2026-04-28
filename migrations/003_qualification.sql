-- 003 — Qualification + internal evaluation subsystems
--
-- Closes the two big assessment gaps for "Toño 2.0":
--   G1: qualification depth — today registration is a 4-data-point capture; HR
--       has no formal "approve this worker for the platform" surface.
--   G2: reputation/performance loop — `ratings` table existed but never wired,
--       and we don't have direct customer relationships in Phase 1, so scoring
--       is INTERNAL: Jose + the architects who supervise the work.
--
-- Idempotent: every DDL guarded by IF NOT EXISTS / OR REPLACE so re-running the
-- migration is safe.

-- ============================================================================
-- 1. Qualification state on tecnicos_extended
-- ============================================================================

alter table tecnicos_extended
  add column if not exists qualification_state text default 'pending';
  -- pending      → new registrant; Toño still gathering context
  -- needs_review → Toño signaled HR has enough info to approve/reject
  -- needs_call   → HR wants a Zoom/phone call before deciding
  -- qualified    → HR approved; create_postulacion is unblocked
  -- rejected     → HR declined; create_postulacion stays blocked

comment on column tecnicos_extended.qualification_state is
  'pending → needs_review → (needs_call →) qualified | rejected';

-- ============================================================================
-- 2. HR qualification calls (optional video/phone validation)
-- ============================================================================

create table if not exists qualification_calls (
  id uuid primary key default gen_random_uuid(),
  tecnico_id text not null references tecnicos_extended(tecnico_id) on delete cascade,
  scheduled_for timestamptz,
  completed_at timestamptz,
  outcome text,        -- approved | rejected | needs_more_info | no_show
  notes text,
  hr_user text,
  created_at timestamptz default now()
);

create index if not exists idx_qualification_calls_tecnico on qualification_calls(tecnico_id);
create index if not exists idx_qualification_calls_outcome on qualification_calls(outcome);

-- ============================================================================
-- 3. Internal evaluations — Jose + arquitectos score post-OT
-- ============================================================================
-- Each row = one evaluator's assessment of one técnico on one OT. Multiple
-- evaluators per OT are fine (Jose AND the supervising arquitecto can both
-- score independently); the view in §4 averages them.

create table if not exists tecnico_evaluations (
  id uuid primary key default gen_random_uuid(),
  tecnico_id text not null references tecnicos_extended(tecnico_id) on delete cascade,
  ot_id text not null,
  evaluator text not null,   -- 'jose' | 'arquitecto:<name>' | 'hr:<email>'

  -- Four dimensions, 1-5 each. Stored separately so future weighting tweaks
  -- don't require a re-write. NULL = "not evaluated on this dimension".
  cumplimiento int check (cumplimiento between 1 and 5),  -- met scope / deadlines
  calidad      int check (calidad      between 1 and 5),  -- technical quality
  actitud      int check (actitud      between 1 and 5),  -- attitude / collaboration
  puntualidad  int check (puntualidad  between 1 and 5),  -- on-time arrival / delivery

  recommend_rehire boolean,  -- "would you give this técnico another OT?" — yes/no/null
  notes text,
  created_at timestamptz default now(),

  -- One evaluator per (tecnico, ot) — re-evaluating overwrites via upsert.
  unique (tecnico_id, ot_id, evaluator)
);

create index if not exists idx_evaluations_tecnico on tecnico_evaluations(tecnico_id);
create index if not exists idx_evaluations_ot      on tecnico_evaluations(ot_id);

-- ============================================================================
-- 4. Aggregated performance view — feeds read_pending_ots ranking
-- ============================================================================
-- Plain view (not materialized): pilot volume (~50–500 workers) makes recompute
-- cheap. Promote to materialized + cron refresh if we cross ~1k técnicos.

create or replace view tecnico_performance as
with eval_avg as (
  -- Per-row average across the four dimensions, ignoring NULLs.
  select
    e.tecnico_id,
    e.id,
    e.recommend_rehire,
    (
      coalesce(e.cumplimiento, 0)
      + coalesce(e.calidad, 0)
      + coalesce(e.actitud, 0)
      + coalesce(e.puntualidad, 0)
    )::numeric
    / nullif(
        (case when e.cumplimiento is null then 0 else 1 end
         + case when e.calidad      is null then 0 else 1 end
         + case when e.actitud      is null then 0 else 1 end
         + case when e.puntualidad  is null then 0 else 1 end),
        0)
    as row_score
  from tecnico_evaluations e
)
select
  t.tecnico_id,
  count(distinct ea.id)                                                  as eval_count,
  round(avg(ea.row_score)::numeric, 2)                                   as avg_score,
  count(*) filter (where ea.recommend_rehire is true)                    as rehire_yes,
  count(*) filter (where ea.recommend_rehire is false)                   as rehire_no,
  count(distinct p.id) filter (where p.state = 'completado')             as jobs_completed,
  count(distinct p.id) filter (
    where p.state in ('descartado','rechazado')
  )                                                                       as jobs_dropped
from tecnicos_extended t
  left join eval_avg ea on ea.tecnico_id = t.tecnico_id
  left join postulaciones p on p.tecnico_id = t.tecnico_id
group by t.tecnico_id;

comment on view tecnico_performance is
  'Aggregated internal evaluation per técnico. Drives read_pending_ots ranking and HR dashboard.';

-- ============================================================================
-- 5. Backfill existing rows so the new gate doesn't lock anyone out
-- ============================================================================
-- Phase 0 dogfood already created tecnicos_extended rows for Jose's warm maestros.
-- Mark every currently-active row as 'qualified' so create_postulacion still works
-- the moment this migration lands. New registrants will start at 'pending' as
-- defined by the column default.

update tecnicos_extended
set qualification_state = 'qualified'
where qualification_state = 'pending'
  and estado = 'activo';
