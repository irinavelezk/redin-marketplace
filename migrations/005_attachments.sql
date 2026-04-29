-- 005 — Outbound message attachments. Lets HR-triggered notifications carry
-- a PDF (or any file in the contratos bucket) as a WhatsApp document, not
-- just plain text. Specifically: when HR clicks "Marcar como enviado" on a
-- contrato, the worker should receive the contract PDF in WhatsApp, not a
-- text saying "te llegó el contrato".

alter table outbound_messages
  add column if not exists kind text not null default 'text',          -- text | document
  add column if not exists attachment_path text,                        -- supabase storage path
  add column if not exists attachment_filename text,                    -- display name in WhatsApp
  add column if not exists attachment_bucket text default 'contratos';  -- which bucket

comment on column outbound_messages.kind is
  'text = body sent as WhatsApp text. document = attachment_path streamed from Storage as a Baileys document with body as caption.';
