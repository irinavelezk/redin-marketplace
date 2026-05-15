-- 012 — Manos daemon: ots_extended table, outbox flags, Storage bucket,
--       and new event types for the architect workflow.
--
-- Adds the persistent layer for Manos (the architect-facing WhatsApp daemon).
-- Key decisions:
--   - ots_extended is the write-side complement to ots_mirror (read-only).
--     It holds alcance_jsonb (structured scope), photo paths, and the AppSheet
--     writeback outbox flags. ot_row_id FK → ots_mirror.row_id allows a simple
--     LEFT JOIN from the mirror for all reads.
--   - appsheet_alcance_pending / _sync_attempts / _last_error follow the exact
--     outbox pattern from tecnicos_extended (Estado_Redin precedent). The
--     projector drains it; if Alcance_OT column doesn't exist in AppSheet yet,
--     it logs the error and leaves pending=true — no crash, no data loss.
--   - alcance-photos Storage bucket: service-role only (no public access).
--     Bucket created idempotently via INSERT ... ON CONFLICT DO NOTHING.
--   - GIN index on arquitectos_mirror for cédula lookups (cedula-gate.ts).
--     Uses expression index on lower(data->>'Cedula'); idempotent.
--
-- Idempotent (safe to re-run via `if not exists` and `on conflict do nothing`).

-- ---------------------------------------------------------------------------
-- 1. ots_extended
-- ---------------------------------------------------------------------------

create table if not exists ots_extended (
  -- FK to the AppSheet mirror row.
  ot_row_id        text primary key references ots_mirror(row_id) on delete cascade,

  -- Structured scope filled by Manos: JSON matching AlcanceSchema in tools.
  alcance_jsonb    jsonb,
  -- Path in alcance-photos bucket: <ot_row_id>/alcance.pdf
  alcance_pdf_path text,
  -- Ordered list of photo paths uploaded by the architect.
  photo_paths      text[] not null default '{}',

  -- Which architect last wrote scope (row_id in arquitectos_mirror).
  last_architect_arq_row_id  text,
  -- The architect's WA phone at write time.
  last_architect_phone       text,

  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  -- AppSheet writeback outbox (mirrors tecnicos_extended pattern).
  appsheet_alcance_pending       boolean not null default false,
  appsheet_alcance_sync_attempts integer not null default 0,
  appsheet_alcance_last_error    text
);

comment on table ots_extended is
  'Manos write-side extension to ots_mirror. Holds architect-submitted alcance (scope) + photo paths + AppSheet writeback state. Read from ots_mirror; write here.';

comment on column ots_extended.appsheet_alcance_pending is
  'True when alcance_jsonb was updated but has not yet been reflected in AppSheet Alcance_OT. Projector drains these; no-ops safely if the column does not exist in AppSheet yet (Estado_Redin precedent).';

-- Auto-update updated_at on any write.
create or replace function ots_extended_set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists ots_extended_updated_at on ots_extended;
create trigger ots_extended_updated_at
  before update on ots_extended
  for each row execute function ots_extended_set_updated_at();

-- ---------------------------------------------------------------------------
-- 2. Indexes
-- ---------------------------------------------------------------------------

-- Efficient lookup of ots_extended rows waiting for AppSheet sync.
create index if not exists ots_extended_alcance_pending_idx
  on ots_extended (appsheet_alcance_pending)
  where appsheet_alcance_pending = true;

-- Cédula lookup in arquitectos_mirror for the cédula gate.
-- Uses a functional index on the lowercased string value.
-- The column may not exist yet in AppSheet (Jose has to add it).
-- We create this as a partial expression index — if the column is absent
-- from all rows it simply indexes nothing and returns no rows, which is the
-- correct "not yet set up" behaviour; no crash.
create index if not exists arquitectos_mirror_cedula_lower_idx
  on arquitectos_mirror ( (lower((data->>'Cedula'))) );

-- ---------------------------------------------------------------------------
-- 3. Supabase Storage bucket: alcance-photos
-- ---------------------------------------------------------------------------
-- Supabase represents buckets as rows in storage.buckets.
-- INSERT ... ON CONFLICT DO NOTHING is the idempotent create pattern
-- that works via the storage schema's REST layer and direct SQL alike.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'alcance-photos',
  'alcance-photos',
  false,         -- NOT public: architects' project photos are private
  52428800,      -- 50 MB per file
  array['image/jpeg','image/png','image/webp','image/heic','application/pdf']
)
on conflict (id) do nothing;

-- RLS policy: only the service role (authenticated with secret key) may
-- read or write. No anon / user JWT access.
-- Policies are idempotent via CREATE POLICY IF NOT EXISTS (PG 15+).
-- The bucket name acts as the bucket_id in storage.objects.

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage'
      and tablename  = 'objects'
      and policyname = 'alcance_photos_service_role_only'
  ) then
    execute $pol$
      create policy alcance_photos_service_role_only
        on storage.objects
        for all
        to service_role
        using (bucket_id = 'alcance-photos')
        with check (bucket_id = 'alcance-photos')
    $pol$;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. sessions.meta — JSON bag for per-session state (e.g., arq_row_id)
-- ---------------------------------------------------------------------------
-- Added here rather than a new migration to keep Manos bootstrap atomic.
-- Idempotent via `add column if not exists`.

alter table sessions
  add column if not exists meta jsonb;

comment on column sessions.meta is
  'Per-session metadata blob. Used by Manos to persist arq_row_id after cédula verification. Keyed by channel — dashboard sessions leave it null.';

-- ---------------------------------------------------------------------------
-- 5. Event type allowlist additions (additive, no breaking change)
-- ---------------------------------------------------------------------------
-- EventoType in shared/src/db-types.ts is a string union with an open
-- `| string` catch-all, so no DB constraint enforces the list.  New values
-- are documented here for the audit trail; the app writes them freely.
--
-- New types added by Manos:
--   alcance_started              — architect first message about an OT's scope
--   alcance_finalized            — finalize_alcance tool succeeded; PDF generated
--   alcance_photo_attached       — attach_photos tool called
--   manos_cedula_verified        — architect's cédula matched arquitectos_mirror
--   manos_cedula_rejected        — cédula presented but not found in mirror
--   customer_contact_intent_attempt — a customer-contact phone sent a message
--                                     to Toño WA (short-circuit, no LLM)
--
-- No DB change needed — documented here for searchability.
-- (If we ever switch EventoType to a PG enum, add an ALTER TYPE here.)
