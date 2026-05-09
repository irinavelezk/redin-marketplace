-- 011 — Callable contact_phone separate from the WhatsApp identity
--
-- Closes a Phase 0a principle violation: until now `tecnicos_extended.phone`
-- doubled as both the WhatsApp identity (often a privacy-mode LID like
-- "+13787...") and "the number HR calls". The dashboard wrapped phone in a
-- tel: link assuming it was callable; it isn't. HR ended up with a masked
-- string that no phone dialer accepts.
--
-- This migration adds a separate `contact_phone` column that the
-- register_tecnico tool collects up-front (with input validation enforcing
-- non-null shape — prompt prose alone was insufficient). Existing rows keep
-- contact_phone NULL until they next message Toño; the dashboard renders
-- "Sin teléfono de contacto" rather than falling back to the LID (which
-- would re-create the bug).
--
-- Identity rule unchanged: cedula remains the only worker identity (per
-- docs/architecture/onboarding-contracts.md decision 6). `phone` (LID) and
-- `contact_phone` are both disposable and may differ.
--
-- Idempotent. Nullable. No DEFAULT. No CHECK. No backfill (intentionally —
-- defaulting to `phone` would re-create the bug).

alter table tecnicos_extended
  add column if not exists contact_phone text;

comment on column tecnicos_extended.contact_phone is
  'Callable phone number for HR. Distinct from `phone` (which is the WhatsApp identity / LID and may be masked / not dialable). Collected by register_tecnico via the validateIdentity gate. NULL on legacy rows until the worker next interacts with Toño.';
