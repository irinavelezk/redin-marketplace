-- 007 — Candidate dossier + 7-state machine + AppSheet reverse-projection + HR notes
--
-- Closes the contracts the end-to-end onboarding flow depends on:
--   1. Rename `qualification_state` → `candidate_state` and lock the canonical
--      7-state machine: screening | pending | needs_call | approved |
--      rejected | withdrawn | revoked. The state values from migration 003 are
--      remapped:
--           pending       (003) → screening   (007)  -- still mid-conversation
--           needs_review  (003) → pending     (007)  -- dossier in HR queue
--           needs_call    (003) → needs_call  (007)  -- unchanged
--           qualified     (003) → approved    (007)  -- vocabulary alignment
--           rejected      (003) → rejected    (007)  -- unchanged
--   2. tecnicos_extended.cedula — the cross-system natural key. Cedula is the
--      ONLY worker identity (decision 6); phones are disposable. Unique-but-
--      nullable so a screening row can exist before cedula is captured.
--   3. AppSheet projection state — outbox pattern. `approved` triggers Add;
--      `revoked` triggers Delete. No other state ever touches AppSheet.
--   4. candidate_dossiers — Toño's structured handoff. Append-only, IMMUTABLE
--      (decision 4). The agent submits one row; HR cannot edit it.
--   5. candidate_decisions — first-class HR action audit (replaces the old
--      qualification_decisions name; cleaner vocab + graduated-autonomy
--      audit columns: tono_recommendation_at_decision_time, agreed_with_tono,
--      hr_reasoning).
--   6. hr_notes — multi-note ongoing HR commentary stream per candidate. This
--      is HR's mutable annotation surface; the dossier itself stays immutable.
--   7. tono_agreement_metrics view — row-level base for measuring HR/Toño
--      agreement by user / week / recommendation type (decision 9).
--   8. tecnicos_extended.withdrawal_reason — captures why a candidate left,
--      so a future return can resume cleanly.
--
-- GRADUATED AUTONOMY (decision 9). Toño produces a RECOMMENDATION; HR makes
-- the DECISION. Both are recorded separately so we can measure agreement and
-- graduate to selective autonomy when data supports it. Phase 1: HR reviews
-- 100%. NO auto-execution of any recommendation, NO confidence-threshold
-- gating, NO graduation mechanism today — only the data foundation.
--
-- ATOMIC SHIP: this migration must land WITH Stream A (agent) AND Stream B
-- (HR + projector) code changes. Standalone application drops `qualification_
-- state`, breaking deployed runtime callers. Apply only when the matching code
-- is staged.
--
-- Idempotent within itself; every DDL guarded by IF NOT EXISTS / OR REPLACE.

-- ============================================================================
-- 1. Candidate state — rename + remap + new value set
-- ============================================================================

alter table tecnicos_extended
  add column if not exists candidate_state text;

-- Backfill from existing qualification_state values (migration 003 vocab).
-- The COALESCE guards rows that somehow lack qualification_state — falls back
-- to 'screening' which is the safe entry state.
update tecnicos_extended
set candidate_state = case coalesce(qualification_state, 'pending')
  when 'pending'      then 'screening'
  when 'needs_review' then 'pending'
  when 'needs_call'   then 'needs_call'
  when 'qualified'    then 'approved'
  when 'rejected'     then 'rejected'
  else                     'screening'
end
where candidate_state is null;

alter table tecnicos_extended
  alter column candidate_state set default 'screening';
alter table tecnicos_extended
  alter column candidate_state set not null;

-- The 7 canonical states. Any future state must be added here AND updated in
-- shared/src/db-types.ts AND tools/src/dossier-types.ts in the same change.
alter table tecnicos_extended
  drop constraint if exists candidate_state_valid;
alter table tecnicos_extended
  add constraint candidate_state_valid check (
    candidate_state in (
      'screening',  -- Toño mid-conversation; pre-dossier
      'pending',    -- dossier submitted; awaiting HR
      'needs_call', -- HR scheduled a call before deciding; same queue, badged
      'approved',   -- HR approved; AppSheet projection in flight or done
      'rejected',   -- HR rejected; may re-apply later via 'reopen'
      'withdrawn',  -- candidate left (no cedula / silence); same phone may resume
      'revoked'     -- previously approved, removed; AppSheet row deleted; terminal
    )
  );

-- Drop the old column. NB: deployed callers MUST already be updated.
alter table tecnicos_extended
  drop column if exists qualification_state;

create index if not exists idx_tecnicos_extended_candidate_state
  on tecnicos_extended (candidate_state);

comment on column tecnicos_extended.candidate_state is
  'Canonical 7-state machine. Legal transitions documented in docs/architecture/onboarding-contracts.md §STATE MACHINE.';

-- Reason a candidate ended up in `withdrawn`. Free-text but populated from a
-- short controlled vocabulary at the tool layer (e.g. 'no_cedula_provided',
-- 'no_response', 'opted_out'). NULL for any state other than 'withdrawn'.
alter table tecnicos_extended
  add column if not exists withdrawal_reason text;

comment on column tecnicos_extended.withdrawal_reason is
  'Why this candidate is withdrawn. Set when state flips to "withdrawn"; cleared on resume.';

-- ============================================================================
-- 2. Cedula — the cross-system identity key
-- ============================================================================
-- Cedula is the ONLY worker identity (decision 6 of the contracts doc).
-- Phones are disposable. UNIQUE so a single cedula cannot live on two
-- tecnicos_extended rows. Captured by Toño during qualification charla, BEFORE
-- submit_candidate_dossier; submission without cedula is rejected at the tool
-- layer (decision 2).

alter table tecnicos_extended
  add column if not exists cedula text;

create unique index if not exists idx_tecnicos_extended_cedula
  on tecnicos_extended (cedula)
  where cedula is not null;

comment on column tecnicos_extended.cedula is
  'Colombian cédula (CC/CE/PEP) — digits only, no separators. UNIQUE. The cross-system natural key. Set before submit_candidate_dossier.';

-- ============================================================================
-- 3. AppSheet reverse-projection state (outbox pattern)
-- ============================================================================
-- Only `approved` triggers projection (Add). Only `revoked` triggers deletion.
-- HR's transition to either state sets the corresponding *_pending flag in the
-- same SQL transaction; the cron drainer drains pending rows every 60s.

alter table tecnicos_extended
  add column if not exists appsheet_row_id text,
  add column if not exists appsheet_sync_pending boolean not null default false,
  add column if not exists appsheet_delete_pending boolean not null default false,
  add column if not exists appsheet_sync_attempts int not null default 0,
  add column if not exists appsheet_sync_last_error text;

create index if not exists idx_tecnicos_extended_appsheet_pending
  on tecnicos_extended (appsheet_sync_pending)
  where appsheet_sync_pending = true;

create index if not exists idx_tecnicos_extended_appsheet_delete_pending
  on tecnicos_extended (appsheet_delete_pending)
  where appsheet_delete_pending = true;

create index if not exists idx_tecnicos_extended_appsheet_row_id
  on tecnicos_extended (appsheet_row_id)
  where appsheet_row_id is not null;

comment on column tecnicos_extended.appsheet_row_id is
  'AppSheet TECNICOS.Row ID once the worker has been projected. NULL = never projected. Cleared on revocation only after AppSheet Delete confirms.';
comment on column tecnicos_extended.appsheet_sync_pending is
  'Set true in the same transaction that flips candidate_state to "approved". Drainer Adds row in AppSheet, captures Row ID, clears flag.';
comment on column tecnicos_extended.appsheet_delete_pending is
  'Set true in the same transaction that flips candidate_state to "revoked". Drainer Deletes the AppSheet row; appsheet_row_id stays for forever-audit.';

-- ============================================================================
-- 4. candidate_dossiers — Toño's structured handoff (IMMUTABLE)
-- ============================================================================
-- Append-only. The agent inserts one row per submission. HR CANNOT edit it
-- (decision 4); HR's annotations live in hr_notes (§6 below). Re-submissions
-- (e.g. agent improves the dossier) are new rows; the latest by created_at is
-- what the queue surfaces.
--
-- GRADUATED AUTONOMY (decision 9) — Toño produces a RECOMMENDATION; HR makes
-- the DECISION. The dossier records the recommendation + confidence + reasoning
-- so HR can evaluate not just *what* Toño concluded but *why*. Today HR
-- reviews 100%; the agreement signal is captured for future selective
-- autonomy. NO auto-execution of any recommendation in v1.
--
--   tono_recommendation = recommend_approve | recommend_reject | recommend_call
--   tono_confidence     = 0.00 .. 1.00 (Toño's self-assessed certainty)
--   tono_reasoning      = short explanation rendered as the "why?" expand on
--                         the HR queue card (Stream B UX)

create table if not exists candidate_dossiers (
  id uuid primary key default gen_random_uuid(),
  tecnico_id text not null references tecnicos_extended(tecnico_id) on delete cascade,
  session_id uuid references sessions(id) on delete set null,
  submitted_by text not null default 'agent',  -- 'agent' (only writer for v1)
  payload jsonb not null,

  -- Denormalized hot fields (copies from payload — payload remains source of truth)
  cedula text not null,                  -- always populated; cedula is required for submission

  -- Graduated-autonomy signal: WHAT Toño suggests, HOW SURE he is, WHY.
  tono_recommendation text not null check (tono_recommendation in (
    'recommend_approve',
    'recommend_reject',
    'recommend_call'
  )),
  tono_confidence numeric(3, 2) not null check (tono_confidence >= 0 and tono_confidence <= 1),
  tono_reasoning text not null,

  prompt_sha text,
  schema_version int not null default 1,
  created_at timestamptz not null default now()
);

create index if not exists idx_dossiers_tecnico_recency
  on candidate_dossiers(tecnico_id, created_at desc);
create index if not exists idx_dossiers_cedula
  on candidate_dossiers(cedula);
create index if not exists idx_dossiers_tono_recommendation
  on candidate_dossiers(tono_recommendation);

comment on table candidate_dossiers is
  'Append-only, IMMUTABLE. Toño-produced candidate dossiers. Latest row per tecnico_id is the one HR reviews. HR-side commentary lives in hr_notes; never overwrite.';
comment on column candidate_dossiers.payload is
  'Full CandidateDossier — see tools/src/dossier-types.ts. Validated at the tool layer (Anthropic input_schema + handler-side coercion).';
comment on column candidate_dossiers.tono_recommendation is
  'Toño''s SUGGESTION (not a final state). HR reviews 100% in Phase 1 — no auto-execution. Used for queue sort + future agreement-rate gating.';
comment on column candidate_dossiers.tono_confidence is
  'Self-reported certainty 0.0-1.0. Drives queue pre-sort (high-confidence reject at bottom, high-confidence approve at top).';
comment on column candidate_dossiers.tono_reasoning is
  'Short explanation of WHY this recommendation. Rendered to HR as a "why?" expand. Crucial for HR to evaluate Toño''s judgment.';

-- ============================================================================
-- 5. candidate_decisions — first-class HR action audit
-- ============================================================================
-- Captures every HR-driven state transition. Agent-driven transitions
-- (screening → pending via dossier; screening → withdrawn) live in eventos
-- because they are recorded by the artifact itself (the dossier row, or a
-- candidate_withdrawn event row).
--
-- decided_by is required: every decision has a human (or 'system' for
-- automated reopens triggered by cedula-on-new-phone resumption).

create table if not exists candidate_decisions (
  id uuid primary key default gen_random_uuid(),
  tecnico_id text not null references tecnicos_extended(tecnico_id) on delete cascade,
  dossier_id uuid references candidate_dossiers(id) on delete set null,

  -- Action vocabulary maps 1:1 to legal HR-driven transitions.
  decision text not null check (decision in (
    'approve',          -- pending|needs_call → approved (also fires AppSheet Add)
    'reject',           -- pending|needs_call → rejected
    'schedule_call',    -- pending           → needs_call
    'unschedule_call',  -- needs_call        → pending
    'revoke',           -- approved          → revoked  (also fires AppSheet Delete)
    'reopen'            -- rejected|withdrawn → screening (worker re-applies)
  )),

  resulting_state text not null check (resulting_state in (
    'screening', 'pending', 'needs_call', 'approved', 'rejected', 'withdrawn', 'revoked'
  )),
  prior_state text not null,

  -- Graduated-autonomy audit (decision 9):
  --   tono_recommendation_at_decision_time: snapshot of what the dossier
  --     recommended at the moment HR clicked. NOT a live join — if a newer
  --     dossier was submitted later, this row preserves what HR actually saw.
  --     NULL when no dossier was reviewed (revoke / reopen / unschedule_call).
  --   agreed_with_tono: derived but stored. Computed by the server action at
  --     write time using the mapping {approve↔recommend_approve,
  --     reject↔recommend_reject, schedule_call↔recommend_call}. NULL on
  --     non-mappable decisions or when no recommendation was on file.
  tono_recommendation_at_decision_time text check (
    tono_recommendation_at_decision_time is null
    or tono_recommendation_at_decision_time in (
         'recommend_approve', 'recommend_reject', 'recommend_call'
       )
  ),
  agreed_with_tono boolean,

  -- WHY HR decided what they decided. Free-text reasoning. Distinct from
  -- ongoing per-candidate notes (those live in hr_notes) — this captures the
  -- specific decision rationale, attached to the action.
  hr_reasoning text,

  decided_by text not null,             -- 'hr:<email>' | 'system' (for automated reopens)
  decided_at timestamptz not null default now()
);

create index if not exists idx_decisions_tecnico_recency
  on candidate_decisions(tecnico_id, decided_at desc);
create index if not exists idx_decisions_decided_at
  on candidate_decisions(decided_at desc);
create index if not exists idx_decisions_agreement
  on candidate_decisions(decided_at desc)
  where agreed_with_tono is not null;

comment on table candidate_decisions is
  'First-class HR action audit. One row per HR transition. Agent-driven transitions live in eventos. Snapshots tono_recommendation_at_decision_time + agreed_with_tono for the graduated-autonomy signal.';
comment on column candidate_decisions.tono_recommendation_at_decision_time is
  'IMMUTABLE snapshot of dossier.tono_recommendation as of decided_at. Preserves what HR actually saw even if a newer dossier is later submitted.';
comment on column candidate_decisions.agreed_with_tono is
  'Computed at write time. true = HR matched Toño''s recommendation; false = HR diverged; NULL = no recommendation in scope (revoke/reopen/unschedule).';
comment on column candidate_decisions.hr_reasoning is
  'Why this decision. Free text. Per-decision; ongoing commentary lives in hr_notes.';

-- ============================================================================
-- 6. hr_notes — HR's mutable annotation stream (decision 4)
-- ============================================================================
-- The dossier is immutable. HR cannot edit it. Instead, HR appends notes here:
-- multi-note, timestamped, attributed. This is the audit trail of human
-- validation — what HR observed on a call, decisions to revisit later, etc.

create table if not exists hr_notes (
  id uuid primary key default gen_random_uuid(),
  tecnico_id text not null references tecnicos_extended(tecnico_id) on delete cascade,
  -- Optional: pin a note to a specific dossier ("this is what I saw in dossier X")
  dossier_id uuid references candidate_dossiers(id) on delete set null,
  body text not null,
  hr_user text not null,                -- 'hr:<email>'
  created_at timestamptz not null default now()
);

create index if not exists idx_hr_notes_tecnico_recency
  on hr_notes(tecnico_id, created_at desc);

comment on table hr_notes is
  'HR''s mutable annotation stream. Append-only at the row level (no UPDATE/DELETE in the app), but HR can add as many as they want over time. Distinct from the immutable dossier and the per-action candidate_decisions.';

-- ============================================================================
-- 7. tono_agreement_metrics — graduated-autonomy data foundation (decision 9)
-- ============================================================================
-- Row-level view exposing every comparable HR decision joined with the Toño
-- recommendation that was on screen at decision time. Pre-aggregated rates are
-- intentionally NOT in this view — consumers GROUP BY whatever slice they
-- need (week, HR user, recommendation type, or any combination).
--
-- Restricted to decisions where comparison is meaningful: a tono_recommendation
-- snapshot exists AND the HR action maps to one of the three recommendable
-- choices (approve/reject/schedule_call). Revoke/reopen/unschedule_call are
-- excluded — they have no recommendation analog and would skew the rate.
--
-- We are NOT building a dashboard for this in v1; the view exists so the data
-- is queryable from day one. Sample queries:
--
--   -- Overall agreement this week:
--   select round(100.0 * count(*) filter (where agreed_with_tono)
--                / nullif(count(*), 0), 1) as agreement_pct
--   from tono_agreement_metrics
--   where decided_week = date_trunc('week', now())::date;
--
--   -- Per HR user:
--   select hr_user, count(*) as decisions,
--          round(100.0 * count(*) filter (where agreed_with_tono)
--                / nullif(count(*), 0), 1) as agreement_pct
--   from tono_agreement_metrics
--   group by hr_user;
--
--   -- Per recommendation type (which classes does Toño get right?):
--   select tono_recommendation,
--          count(*) as decisions,
--          round(100.0 * count(*) filter (where agreed_with_tono)
--                / nullif(count(*), 0), 1) as agreement_pct
--   from tono_agreement_metrics
--   group by tono_recommendation;

create or replace view tono_agreement_metrics as
select
  d.id                                                  as decision_id,
  d.tecnico_id,
  d.dossier_id,
  d.decided_at,
  date_trunc('day',  d.decided_at)::date                as decided_day,
  date_trunc('week', d.decided_at)::date                as decided_week,
  d.decided_by                                           as hr_user,
  d.tono_recommendation_at_decision_time                as tono_recommendation,
  d.decision                                             as hr_decision,
  d.agreed_with_tono
from candidate_decisions d
where d.tono_recommendation_at_decision_time is not null
  and d.decision in ('approve', 'reject', 'schedule_call');

comment on view tono_agreement_metrics is
  'Graduated-autonomy signal source. One row per comparable HR decision. Group by decided_week / decided_day / hr_user / tono_recommendation as needed.';

-- ============================================================================
-- 8. Backfill — preserve current state for the deployed pilot
-- ============================================================================
-- Existing rows where the row_id comes from tecnicos_mirror are warm-imported
-- maestros; their tecnico_id IS already an AppSheet Row ID (per the original
-- 001 sync logic). Capture that as appsheet_row_id and stamp synced_at so the
-- projector skips them and architects keep their existing autocomplete behavior.

update tecnicos_extended t
set
  appsheet_row_id = t.tecnico_id,
  appsheet_synced_at = coalesce(t.appsheet_synced_at, t.onboarded_at)
where t.appsheet_row_id is null
  and exists (
    select 1 from tecnicos_mirror m where m.row_id = t.tecnico_id
  );
