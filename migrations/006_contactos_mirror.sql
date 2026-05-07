-- 006 — Mirror AppSheet's CONTACTOS table so we can resolve a customer phone
-- from an OT's Contacto_Asignado FK without a live AppSheet round-trip.
--
-- Required by the autonomous post-completion rating flow: when an OT flips
-- to "Terminado", the sync worker enqueues a WhatsApp from Toño to the
-- customer asking for stars + comment. The customer phone lives only in
-- AppSheet's CONTACTOS table (column "Telefono"), reachable from the OT
-- via "Contacto_Asignado" (= ID_Contacto). Pull it into Supabase so the
-- enqueue path can do a single indexed lookup.

create table if not exists contactos_mirror (
  row_id text primary key,
  id_contacto text,
  telefono text,
  data jsonb not null,
  synced_at timestamptz default now()
);

create index if not exists contactos_mirror_id_contacto_idx
  on contactos_mirror (id_contacto);

comment on table contactos_mirror is
  'Read-only mirror of AppSheet CONTACTOS. id_contacto matches Ordenes_Trabajo.Contacto_Asignado.';
