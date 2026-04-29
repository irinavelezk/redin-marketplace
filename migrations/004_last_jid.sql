-- 004 — Persist the actual WhatsApp JID per worker so outbound notifications
-- reach LID-style accounts (privacy-mode users).
--
-- Background: WhatsApp introduced "LIDs" (Linked Identifiers) for accounts
-- with phone-number privacy on. Inbound messages from those accounts arrive
-- with a JID like "<digits>@lid" instead of "<digits>@s.whatsapp.net".
-- Toño's in-chat replies use the inbound JID directly so they always work.
-- The outbound drainer, however, rebuilt JIDs from the stored phone digits
-- with a hardcoded "@s.whatsapp.net" suffix, which silently misses LID
-- accounts: WhatsApp takes the message and never delivers it; Baileys
-- reports OK back; we mark "sent" but the user hears nothing.
--
-- Fix: store the actual inbound JID per worker on tecnicos_extended, and
-- have the outbound drainer prefer it over the rebuilt JID.

alter table tecnicos_extended
  add column if not exists last_jid text;

comment on column tecnicos_extended.last_jid is
  'Most recent Baileys JID for this worker (e.g. "X@s.whatsapp.net" or "X@lid"). Outbound drainer uses this if present.';
