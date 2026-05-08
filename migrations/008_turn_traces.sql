-- 008 — Per-turn trace + cost kill switch
--
-- 1. `turns` — denormalized per-turn projection of messages + llm_call eventos.
--    Live tests start in hours; "what happened in turn 4 of session X" needs
--    to be one row, not a 4-event stitch.
--
-- 2. Cost kill switch — daily USD cap on Toño's NEW conversations. Default
--    $10/day, configurable via env TONO_DAILY_COST_USD_LIMIT. In-flight
--    conversations always continue. Manual override via cost_kill_switch_overrides.
--    HR dashboard reads `daily_llm_cost` for the live spend widget.
--
-- Idempotent.

-- ============================================================================
-- 1. turns — the operations table for per-turn debugging
-- ============================================================================

create table if not exists turns (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references sessions(id) on delete cascade,
  -- 1-based within the session. UNIQUE so an agent crash + re-write lands once.
  turn_number int not null,

  -- Identity context (denormalized at write time)
  phone text not null,
  channel text not null,                  -- whatsapp | dashboard
  tecnico_id text,                        -- null until identify_user / register_tecnico
  candidate_state_at_turn text,           -- snapshot read at turn start

  -- Conversation slice
  inbound_text text not null,             -- raw user message (NOT the wrapped <data>)
  outbound_text text,                     -- final agent reply (null if model returned empty)

  -- Tool calls executed in this turn — array of:
  --   [{ name, args, result_ok, code, latency_ms }, ...]
  -- Full tool result payloads stay in messages.tool_calls (jsonb) — this is
  -- the lean operations view.
  tool_calls jsonb,

  -- LLM accounting
  model text,                             -- e.g. 'claude-haiku-4-5'
  prompt_sha text,                        -- TONO_PROMPT_SHA at call time
  prompt_tokens int,
  completion_tokens int,
  llm_iterations int,                     -- inner tool-use loop iterations

  -- Wall-clock latency from inbound persisted → outbound persisted
  latency_ms int,

  -- Error surface — null on success.
  -- Common shapes:
  --   {stage:'llm', code:'model_unavailable'}     — Anthropic 5xx after retry
  --   {stage:'llm', code:'timeout'}               — withTimeout fired
  --   {stage:'router', code:'max_tools_reached'}  — Rule 3 bit
  --   {stage:'router', code:'not_identified'}     — Rule 1 bit
  --   {stage:'tool',   code:'<tool_code>'}        — any tool returning ok:false
  --   {stage:'cost',   code:'kill_switch'}        — turn refused due to budget cap
  errors jsonb,

  -- Final-state flags for fast filtering
  escalated boolean not null default false,
  refused boolean not null default false,
  cost_killed boolean not null default false,        -- this turn was refused by the kill switch

  started_at timestamptz not null default now(),
  finished_at timestamptz,

  unique (session_id, turn_number)
);

create index if not exists idx_turns_session on turns(session_id, turn_number);
create index if not exists idx_turns_phone on turns(phone, started_at desc);
create index if not exists idx_turns_started_at on turns(started_at desc);
create index if not exists idx_turns_escalated on turns(started_at desc) where escalated = true;
create index if not exists idx_turns_with_errors on turns(started_at desc) where errors is not null;
create index if not exists idx_turns_cost_killed on turns(started_at desc) where cost_killed = true;

comment on table turns is
  'One row per user turn. Denormalized projection of messages + llm_call eventos for live debug. Source of truth for per-turn cost reporting.';

-- ============================================================================
-- 2. turn_costs — per-turn USD using current Haiku 4.5 list rates
-- ============================================================================
-- View, not a generated column, so a rate change is a one-line UPDATE and
-- back-corrects historical rows automatically.

create or replace view turn_costs as
select
  t.id,
  t.session_id,
  t.turn_number,
  t.phone,
  t.model,
  t.prompt_tokens,
  t.completion_tokens,
  -- Hardcoded Haiku 4.5 rates (USD per 1M tokens). Bump on model swap.
  round(
    (coalesce(t.prompt_tokens, 0) * 0.80 / 1000000.0)
    + (coalesce(t.completion_tokens, 0) * 4.00 / 1000000.0),
    6
  )::numeric as cost_usd,
  t.latency_ms,
  t.started_at
from turns t;

comment on view turn_costs is
  'Per-turn USD cost using current Haiku 4.5 list rates. Bump rate constants on model swap.';

-- ============================================================================
-- 3. daily_llm_cost — daily roll-up powering the kill switch + dashboard widget
-- ============================================================================
-- UTC days. The kill switch resets at UTC midnight automatically (because
-- "today's spend" is computed against now() at UTC, and yesterday is a
-- different bucket).

create or replace view daily_llm_cost as
select
  date_trunc('day', t.started_at at time zone 'UTC')::date as utc_date,
  sum(coalesce(t.prompt_tokens, 0))                        as prompt_tokens,
  sum(coalesce(t.completion_tokens, 0))                    as completion_tokens,
  round(
    sum(
      (coalesce(t.prompt_tokens, 0) * 0.80 / 1000000.0)
      + (coalesce(t.completion_tokens, 0) * 4.00 / 1000000.0)
    ),
    4
  )::numeric                                                 as cost_usd,
  count(*)                                                   as turn_count,
  count(distinct t.session_id)                               as session_count
from turns t
group by date_trunc('day', t.started_at at time zone 'UTC')::date;

comment on view daily_llm_cost is
  'Daily Anthropic spend rolled up from turns. UTC days. Drives the cost kill switch + the HR dashboard live spend widget.';

-- ============================================================================
-- 4. cost_kill_switch_overrides — manual reset
-- ============================================================================
-- When a row exists for the current UTC day, the agent IGNORES the daily cap
-- for that day. HR creates an override from the dashboard ("reset cost cap")
-- with a reason. Auto-reset is implicit (next UTC day = no override row =
-- fresh budget).

create table if not exists cost_kill_switch_overrides (
  id uuid primary key default gen_random_uuid(),
  override_date date not null,                              -- UTC day to override
  reset_by text not null,                                   -- 'hr:<email>'
  reset_at timestamptz not null default now(),
  reason text
);

create unique index if not exists idx_cost_overrides_date
  on cost_kill_switch_overrides (override_date);

comment on table cost_kill_switch_overrides is
  'Manual reset entries. When a row exists for today (UTC), the agent ignores the daily cap. Auto-reset = no override row tomorrow.';
