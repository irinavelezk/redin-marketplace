// upload_documento — stores a document in Supabase Storage, writes documentos row,
// logs an event. Two modes:
//   1) content + contentType + filename  → this tool uploads to storage
//   2) storage_path already set          → we only record the row (dashboard already uploaded)

import { randomUUID } from "node:crypto";
import type { ToolContext } from "./context";
import { recordEvent } from "./events";
import type {
  ToolResult,
  UploadDocumentoInput,
  UploadDocumentoOutput,
} from "./types";
import { err, ok } from "./types";

const BUCKET = "documentos";
const VALID_TIPOS = new Set([
  "cedula",
  "cert_electrica",
  "arl",
  "ss",
  "altura",
  "antecedentes",
  "otro",
  // Story 17: optional dossier document types
  "cert_estudios",
  "cert_trabajos_previos",
  "evidencia_arl",
  // 2026-05-17: EPS evidence (self-declared eps_activa + uploaded carné)
  "evidencia_eps",
]);

function safeFilename(name: string): string {
  // Strip path components and anything weird. Keep dots for extension.
  const base = name.split(/[\\/]/).pop() ?? "file";
  return base.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) || "file";
}

export async function uploadDocumento(
  ctx: ToolContext,
  input: UploadDocumentoInput
): Promise<ToolResult<UploadDocumentoOutput>> {
  if (!input.tecnico_id?.trim()) return err("tecnico_id required", { code: "invalid_input" });
  if (!VALID_TIPOS.has(input.tipo)) {
    return err(`tipo must be one of: ${[...VALID_TIPOS].join(", ")}`, {
      code: "invalid_input",
    });
  }
  if (!input.storage_path && !input.content) {
    return err("either storage_path or content must be provided", { code: "invalid_input" });
  }

  // Verify the técnico exists.
  const { data: tec, error: tecErr } = await ctx.supabase
    .from("tecnicos_extended")
    .select("tecnico_id")
    .eq("tecnico_id", input.tecnico_id)
    .maybeSingle();
  if (tecErr) {
    return err(`db error: ${tecErr.message}`, { code: "db_error", retryable: true });
  }
  if (!tec) return err("tecnico_id not found", { code: "not_found" });

  let storagePath = input.storage_path?.trim() ?? "";

  if (!storagePath) {
    const fname = safeFilename(input.filename || "documento");
    storagePath = `${input.tecnico_id}/${input.tipo}/${Date.now()}-${randomUUID()}-${fname}`;
    const body = input.content instanceof Buffer ? input.content : Buffer.from(input.content!);
    const { error: upErr } = await ctx.supabase.storage
      .from(BUCKET)
      .upload(storagePath, body, {
        contentType: input.contentType ?? "application/octet-stream",
        upsert: false,
      });
    if (upErr) {
      return err(`storage upload failed: ${upErr.message}`, {
        code: "storage_error",
        retryable: true,
      });
    }
  }

  const { data: inserted, error: insertErr } = await ctx.supabase
    .from("documentos")
    .insert({
      tecnico_id: input.tecnico_id,
      tipo: input.tipo,
      storage_path: storagePath,
    })
    .select("id")
    .single();
  if (insertErr) {
    return err(`insert failed: ${insertErr.message}`, {
      code: "db_error",
      retryable: true,
    });
  }

  await recordEvent(ctx, {
    type: "document_uploaded",
    entity_id: inserted.id,
    actor: input.actor ?? ctx.defaultActor,
    meta: {
      tecnico_id: input.tecnico_id,
      tipo: input.tipo,
      storage_path: storagePath,
    },
  });

  return ok({ documento_id: inserted.id, storage_path: storagePath });
}
