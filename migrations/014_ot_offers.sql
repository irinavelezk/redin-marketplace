-- 014 — ot_offers: per-(OT, técnico) job offers triggered by HR from the shortlist.
--
-- This is the v1 supply-push mechanism: HR sees ranked approved técnicos for an
-- OT in state 4, picks one, and clicks "Enviar oferta". The system:
--   1. Inserts an ot_offers row in state 'sent'
--   2. Enqueues a WhatsApp text message + the alcance PDF document via outbound_messages
--   3. Pings HR Telegram with the action
-- When the worker replies "acepto" or "paso" on WhatsApp, Toño's pre-LLM
-- offer-reply matcher updates the row to 'accepted' or 'rejected'.
-- On acceptance, a postulaciones row is upserted in state 'preseleccionado'
-- so the existing "Generar contrato" flow on /hr/shortlist takes over unchanged.
--
-- Design:
--   - State machine: sent -> accepted | rejected | expired
--   - One ACTIVE offer per (ot_row_id, tecnico_id) — partial unique on state='sent'.
--     Rejected/expired offers stay in the table for audit; HR can re-send (new row).
--   - text_message_id + document_message_id link back to outbound_messages for
--     traceability of what was actually delivered.
--   - 72h response window: expires_at default sent_at + 72h. Inbound matcher uses
--     this; a cron can sweep stale rows to 'expired' (separate concern, out of v1).
--
-- Distinct from the existing `ofertas` table (broadcast model, unused in v1):
--   ofertas      = 1 oferta broadcast to N tecnicos (cron-driven future)
--   ot_offers    = 1 oferta per (OT, tecnico) (HR-driven v1, this migration)
--
-- Idempotent.

-- ============================================================================
-- 1. ot_offers table
-- ============================================================================

create table if not exists ot_offers (
  id              uuid primary key default gen_random_uuid(),
  ot_row_id       text not null references ots_mirror(row_id) on delete cascade,
  tecnico_id      text not null references tecnicos_extended(tecnico_id) on delete cascade,
  state           text not null default 'sent'
                    check (state in ('sent','accepted','rejected','expired')),
  sent_at         timestamptz not null default now(),
  responded_at    timestamptz,
  expires_at      timestamptz not null default (now() + interval '72 hours'),
  response_text   text,
  text_message_id      uuid references outbound_messages(id) on delete set null,
  document_message_id  uuid references outbound_messages(id) on delete set null,
  hr_user_email   text,
  meta            jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

comment on table ot_offers is
  'HR-triggered per-tecnico job offers for state-4 OTs. Workflow: HR sends offer -> WA text+PDF delivered -> worker replies acepto/paso -> state machine updates. On accepted, a postulaciones row is upserted in preseleccionado for the existing contract flow.';

comment on column ot_offers.state is
  'sent | accepted | rejected | expired. Only one row per (ot_row_id, tecnico_id) may be in state=sent (partial unique index).';

comment on column ot_offers.text_message_id is
  'FK to outbound_messages — the text portion of the offer DM (greeting + ciudad + ask + alcance summary).';

comment on column ot_offers.document_message_id is
  'FK to outbound_messages — the alcance PDF attachment.';

-- Auto-update updated_at on every UPDATE.
create or replace function ot_offers_set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists ot_offers_updated_at on ot_offers;
create trigger ot_offers_updated_at
  before update on ot_offers
  for each row execute function ot_offers_set_updated_at();

-- ============================================================================
-- 2. Indexes
-- ============================================================================

-- One active (state=sent) offer per (OT, tecnico). Resends after rejection/expiry
-- are allowed because the prior row no longer qualifies for this partial unique.
create unique index if not exists ot_offers_active_pair_idx
  on ot_offers (ot_row_id, tecnico_id)
  where state = 'sent';

-- Inbound response matcher: latest sent offer for a given tecnico within window.
create index if not exists ot_offers_tecnico_sent_idx
  on ot_offers (tecnico_id, sent_at desc)
  where state = 'sent';

-- HR pipeline view: all offers for a given OT, recent first.
create index if not exists ot_offers_ot_idx
  on ot_offers (ot_row_id, sent_at desc);

-- General state-based queries (dashboard tabs, cron sweeps).
create index if not exists ot_offers_state_sent_idx
  on ot_offers (state, sent_at desc);

-- ============================================================================
-- 3. Event types — documented for reference
-- ============================================================================
-- New event types in use after this migration (free-text strings; no DB constraint):
--   offer_sent       — HR clicked "Enviar oferta" and the WA was queued
--   offer_accepted   — worker replied accept; postulacion upserted in preseleccionado
--   offer_rejected   — worker replied reject
--   offer_expired    — cron swept past expires_at (out of v1 scope)
