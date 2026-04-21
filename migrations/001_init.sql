-- Redin Marketplace v1 — initial schema
-- Applied via Supabase Management API on 2026-04-19

-- ============================================================================
-- Marketplace-native tables (owned by us)
-- ============================================================================

create table tecnicos_extended (
  tecnico_id text primary key,
  phone text unique not null,
  lider_phone text,
  estado text default 'activo',             -- activo | pausado | baneado
  onboarded_at timestamptz default now(),
  source text,                              -- warm | ape | facebook | referral | dashboard
  appsheet_synced_at timestamptz
);

create table sessions (
  id uuid primary key default gen_random_uuid(),
  phone text not null,
  channel text not null,                    -- whatsapp | dashboard
  started_at timestamptz default now(),
  last_active timestamptz default now()
);

create table messages (
  id uuid primary key default gen_random_uuid(),
  session_id uuid references sessions(id) on delete cascade,
  role text not null,                       -- user | assistant | tool
  content text,
  tool_calls jsonb,
  created_at timestamptz default now()
);

create table postulaciones (
  id uuid primary key default gen_random_uuid(),
  ot_id text not null,
  tecnico_id text not null,
  state text not null default 'postulado',  -- postulado | preseleccionado | asignado | rechazado | descartado | completado
  mensaje text,
  applied_at timestamptz default now(),
  decided_at timestamptz,
  decided_by text,                          -- 'hr:<user>' | 'agent:auto'
  unique (ot_id, tecnico_id)
);

create table ofertas (
  id uuid primary key default gen_random_uuid(),
  ot_id text not null,
  tecnico_ids text[] not null,
  sent_at timestamptz default now(),
  expires_at timestamptz,
  channel text default 'whatsapp'
);

create table contratos (
  id uuid primary key default gen_random_uuid(),
  tecnico_id text not null,
  ot_id text,
  status text default 'borrador',           -- borrador | enviado | firmado | cancelado
  pdf_storage_path text,
  signed_pdf_storage_path text,
  zapsign_id text,
  sent_at timestamptz,
  signed_at timestamptz,
  created_by text
);

create table documentos (
  id uuid primary key default gen_random_uuid(),
  tecnico_id text not null,
  tipo text not null,                       -- cedula | cert_electrica | arl | ss | altura | antecedentes | otro
  storage_path text not null,
  validated_by text,
  validated_at timestamptz,
  uploaded_at timestamptz default now()
);

create table eventos (
  id uuid primary key default gen_random_uuid(),
  type text not null,
  entity_id text,
  actor text,                               -- 'agent' | 'hr:<user>' | 'tecnico:<phone>'
  meta jsonb,
  created_at timestamptz default now()
);

create table ratings (
  id uuid primary key default gen_random_uuid(),
  ot_id text not null,
  rater text not null,
  ratee text not null,
  stars int check (stars between 1 and 5),
  notes text,
  created_at timestamptz default now()
);

-- ============================================================================
-- Mirror tables (AppSheet → Supabase read-only cache)
-- ============================================================================

create table tecnicos_mirror (
  row_id text primary key,
  data jsonb not null,
  synced_at timestamptz default now()
);

create table ots_mirror (
  row_id text primary key,
  data jsonb not null,
  ciudad text,
  especialidad text,
  estado text,
  synced_at timestamptz default now()
);

create table clientes_mirror (
  row_id text primary key,
  data jsonb not null,
  synced_at timestamptz default now()
);

create table arquitectos_mirror (
  row_id text primary key,
  data jsonb not null,
  synced_at timestamptz default now()
);

create table actividades_mirror (
  row_id text primary key,
  data jsonb not null,
  synced_at timestamptz default now()
);

-- ============================================================================
-- Indexes
-- ============================================================================

create index idx_postulaciones_ot on postulaciones(ot_id);
create index idx_postulaciones_tecnico on postulaciones(tecnico_id);
create index idx_postulaciones_state on postulaciones(state);
create index idx_sessions_phone on sessions(phone);
create index idx_messages_session on messages(session_id);
create index idx_eventos_type on eventos(type);
create index idx_eventos_entity on eventos(entity_id);
create index idx_ofertas_ot on ofertas(ot_id);
create index idx_contratos_tecnico on contratos(tecnico_id);
create index idx_contratos_status on contratos(status);
create index idx_documentos_tecnico on documentos(tecnico_id);
create index idx_ots_mirror_ciudad on ots_mirror(ciudad);
create index idx_ots_mirror_estado on ots_mirror(estado);
create index idx_tecnicos_ext_lider on tecnicos_extended(lider_phone);
