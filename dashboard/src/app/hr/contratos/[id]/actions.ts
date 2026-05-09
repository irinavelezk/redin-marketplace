// Two-button contract workflow per friction #3:
//
//   "Generar y enviar"   → generateAndSend
//     1. generate the PDF (renders + uploads to contratos bucket)
//     2. flip status borrador → enviado, set sent_at
//     3. enqueue WhatsApp document delivery to the worker
//     4. log eventos.contract_sent
//   one click; HR no longer needs to hit Descargar before Enviar.
//
//   "Subir firmado"      → mintSignedUploadUrl + recordSignedUpload
//     1. server mints a Supabase Storage signed upload URL (~5 min TTL)
//     2. client uploads the file directly to the bucket — bypasses Next.js
//        server-action body size limits AND the Railway proxy
//     3. server records the path, flips status to firmado, flips the
//        postulación to asignado, sends the "asignado" WA, logs event
//   one click after the file is picked.
//
// generateAndSend is a form action (no return value beyond void/redirect).
// mintSignedUploadUrl and recordSignedUpload are imperatively-called actions
// that return JSON so the client component can chain them.

"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  enqueueWhatsApp,
  enqueueWhatsAppDocument,
  tecnicoNotificationContext,
} from "@/lib/notify";
import { generateAndUploadContractPdf } from "@/lib/contract-pdf";
import { serverClientBoundToCookies, serviceClient } from "@/lib/supabase-server";

const BUCKET = "contratos";

export async function generateAndSend(formData: FormData): Promise<void> {
  const auth = serverClientBoundToCookies();
  const { data: userData } = await auth.auth.getUser();
  if (!userData.user) redirect("/login");
  const hrEmail = userData.user.email ?? userData.user.id;

  const contractId = formData.get("contract_id");
  if (typeof contractId !== "string" || !contractId) return;

  const supa = serviceClient();
  const { data: contract } = await supa
    .from("contratos")
    .select("id, tecnico_id, ot_id, status, created_by")
    .eq("id", contractId)
    .maybeSingle();
  if (!contract) return;
  // Idempotency: if already enviado/firmado, don't regenerate or re-send.
  // Surfaces silently (page refresh shows current state) rather than throwing
  // because a double-click is the most common cause and the user will see
  // "enviado" already on the next render.
  if (contract.status !== "borrador") {
    revalidatePath(`/hr/contratos/${contractId}`);
    return;
  }

  // 1. PDF gen + upload (idempotent — upserts).
  const { storagePath } = await generateAndUploadContractPdf(supa, contract);

  // 2. State flip + sent_at.
  const nowIso = new Date().toISOString();
  await supa
    .from("contratos")
    .update({ status: "enviado", sent_at: nowIso })
    .eq("id", contractId);
  await supa.from("eventos").insert({
    type: "contract_sent",
    entity_id: contractId,
    actor: `hr:${hrEmail}`,
    meta: { storage_path: storagePath },
  });

  // 3. WA document delivery.
  if (contract.tecnico_id) {
    const { phone, descripcion } = await tecnicoNotificationContext(
      supa,
      contract.tecnico_id,
      contract.ot_id
    );
    if (phone) {
      const trabajo = descripcion ?? "el trabajo";
      await enqueueWhatsAppDocument(supa, {
        phone,
        body: `Te llegó el contrato de "${trabajo}". Revísalo y firma cuando puedas — cualquier duda me dices.`,
        attachment_path: storagePath,
        attachment_filename: `contrato-${contractId.slice(0, 8)}.pdf`,
        attachment_bucket: BUCKET,
        meta: { kind: "contract_sent", contract_id: contractId },
      });
    }
  }

  revalidatePath(`/hr/contratos/${contractId}`);
  revalidatePath("/hr/contratos");
}

// Mints a signed upload URL the client can PUT directly to. Path layout
// pins the upload under the contract's folder so future audit (list bucket
// by contract id) is trivial. ext is sanitized to a small allowlist.
export async function mintSignedUploadUrl(args: {
  contractId: string;
  filename: string;
}): Promise<
  | { ok: true; signedUrl: string; token: string; path: string }
  | { ok: false; error: string }
> {
  const auth = serverClientBoundToCookies();
  const { data: userData } = await auth.auth.getUser();
  if (!userData.user) return { ok: false, error: "auth_required" };

  const { contractId, filename } = args;
  if (!contractId || !filename) return { ok: false, error: "missing_args" };

  const ext = (filename.split(".").pop() ?? "").toLowerCase();
  const allowed = new Set(["pdf", "jpg", "jpeg", "png", "heic", "webp"]);
  if (!allowed.has(ext)) return { ok: false, error: "unsupported_extension" };

  const supa = serviceClient();
  const { data: contract } = await supa
    .from("contratos")
    .select("id")
    .eq("id", contractId)
    .maybeSingle();
  if (!contract) return { ok: false, error: "contract_not_found" };

  const path = `${contractId}/signed-${Date.now()}.${ext}`;
  const { data, error } = await supa.storage
    .from(BUCKET)
    .createSignedUploadUrl(path);
  if (error || !data) return { ok: false, error: error?.message ?? "mint_failed" };
  return { ok: true, signedUrl: data.signedUrl, token: data.token, path };
}

// Called after the client has PUT the file. Records the path on the
// contract row, flips status to firmado, flips postulación to asignado,
// and notifies the worker.
export async function recordSignedUpload(args: {
  contractId: string;
  path: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const auth = serverClientBoundToCookies();
  const { data: userData } = await auth.auth.getUser();
  if (!userData.user) return { ok: false, error: "auth_required" };
  const hrEmail = userData.user.email ?? userData.user.id;

  const { contractId, path } = args;
  if (!contractId || !path) return { ok: false, error: "missing_args" };

  const supa = serviceClient();
  const nowIso = new Date().toISOString();
  const { error: updateErr } = await supa
    .from("contratos")
    .update({
      status: "firmado",
      signed_at: nowIso,
      signed_pdf_storage_path: path,
    })
    .eq("id", contractId);
  if (updateErr) return { ok: false, error: updateErr.message };

  const { data: contract } = await supa
    .from("contratos")
    .select("ot_id, tecnico_id")
    .eq("id", contractId)
    .maybeSingle();
  await supa.from("eventos").insert({
    type: "contract_signed",
    entity_id: contractId,
    actor: `hr:${hrEmail}`,
    meta: {
      ot_id: contract?.ot_id ?? null,
      tecnico_id: contract?.tecnico_id ?? null,
      signed_path: path,
    },
  });

  if (contract?.ot_id && contract?.tecnico_id) {
    await supa
      .from("postulaciones")
      .update({
        state: "asignado",
        decided_at: nowIso,
        decided_by: `hr:${hrEmail}`,
      })
      .eq("ot_id", contract.ot_id)
      .eq("tecnico_id", contract.tecnico_id);

    const { phone, descripcion } = await tecnicoNotificationContext(
      supa,
      contract.tecnico_id,
      contract.ot_id
    );
    if (phone) {
      const trabajo = descripcion ?? "el trabajo";
      await enqueueWhatsApp(supa, {
        phone,
        body: `Listo — quedaste asignado a "${trabajo}". ¡Manos a la obra! Cualquier cosa me dices.`,
        meta: { kind: "asignado", contract_id: contractId, ot_id: contract.ot_id },
      });
    }
  }

  revalidatePath(`/hr/contratos/${contractId}`);
  revalidatePath("/hr/contratos");
  return { ok: true };
}
