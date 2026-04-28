-- 002 — outbound message queue. Cross-process WhatsApp send: dashboard-mp
-- enqueues, tono-mp drains via Baileys (single Baileys session per WA account
-- means dashboard cannot send directly).
--
-- Producers: HR shortlist actions, contract-state changes, future new-OT
-- broadcasts. Consumer: tono-mp's runner polls pending rows on a short interval.

create table if not exists outbound_messages (
  id uuid primary key default gen_random_uuid(),
  phone text not null,
  body text not null,
  channel text not null default 'whatsapp',  -- whatsapp | telegram (future)
  status text not null default 'pending',    -- pending | sent | failed
  attempts int not null default 0,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  last_error text,
  meta jsonb
);

create index if not exists idx_outbound_pending
  on outbound_messages (created_at)
  where status = 'pending';

create index if not exists idx_outbound_phone on outbound_messages (phone);
