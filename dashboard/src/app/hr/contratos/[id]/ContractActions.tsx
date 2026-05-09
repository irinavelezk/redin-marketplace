// Two-button contract action bar (friction #3). Lives next to the contract
// detail page so the page itself stays a server component.
//
//   [Generar y enviar]     — borrador only, posts to generateAndSend.
//   [Subir firmado]        — enviado/firmado, picks a file, uploads via
//                            signed URL, then records the path.
//
// The signed-URL upload is what lets us avoid the 1MB Next.js server-action
// body cap AND the Railway proxy limit.

"use client";

import { useState, useTransition } from "react";
import { browserClient } from "@/lib/supabase-browser";
import { generateAndSend, mintSignedUploadUrl, recordSignedUpload } from "./actions";

type ContractStatus = "borrador" | "enviado" | "firmado" | "cancelado";

interface Props {
  contractId: string;
  status: ContractStatus;
}

const BUCKET = "contratos";

export function ContractActions({ contractId, status }: Props): JSX.Element {
  const [sending, startSending] = useTransition();
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function onSendClick(): void {
    setError(null);
    const fd = new FormData();
    fd.set("contract_id", contractId);
    startSending(async () => {
      try {
        await generateAndSend(fd);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Error desconocido");
      }
    });
  }

  async function onFilePicked(e: React.ChangeEvent<HTMLInputElement>): Promise<void> {
    setError(null);
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-pick of the same name later
    if (!file) return;

    setUploading(true);
    try {
      const minted = await mintSignedUploadUrl({
        contractId,
        filename: file.name,
      });
      if (!minted.ok) {
        setError(`No se pudo iniciar la subida: ${minted.error}`);
        return;
      }
      const supa = browserClient();
      const { error: upErr } = await supa.storage
        .from(BUCKET)
        .uploadToSignedUrl(minted.path, minted.token, file, {
          contentType: file.type || undefined,
          upsert: true,
        });
      if (upErr) {
        setError(`Falló la subida del archivo: ${upErr.message}`);
        return;
      }
      const recorded = await recordSignedUpload({
        contractId,
        path: minted.path,
      });
      if (!recorded.ok) {
        setError(`Subido pero no se marcó como firmado: ${recorded.error}`);
        return;
      }
      // Server action revalidates — the page re-renders with status=firmado.
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error desconocido");
    } finally {
      setUploading(false);
    }
  }

  const canSend = status === "borrador";
  const canUploadSigned = status === "enviado" || status === "firmado";

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2 items-center">
        <button
          type="button"
          onClick={onSendClick}
          disabled={!canSend || sending}
          className="text-sm bg-emerald-600 hover:bg-emerald-700 disabled:bg-slate-200 disabled:text-slate-500 disabled:cursor-not-allowed text-white rounded-md px-4 py-1.5"
        >
          {sending
            ? "Generando y enviando…"
            : status === "borrador"
            ? "Generar y enviar"
            : "Ya enviado"}
        </button>

        <label
          className={`text-sm rounded-md px-4 py-1.5 cursor-pointer ${
            canUploadSigned && !uploading
              ? "bg-slate-900 hover:bg-slate-800 text-white"
              : "bg-slate-200 text-slate-500 cursor-not-allowed"
          }`}
        >
          {uploading
            ? "Subiendo…"
            : status === "firmado"
            ? "Reemplazar firmado"
            : "Subir firmado"}
          <input
            type="file"
            accept="application/pdf,image/*"
            disabled={!canUploadSigned || uploading}
            onChange={onFilePicked}
            className="hidden"
          />
        </label>

        <a
          href={`/api/contract/${contractId}/draft`}
          target="_blank"
          rel="noreferrer"
          className="text-sm text-slate-600 hover:text-slate-900 underline-offset-2 hover:underline"
        >
          Descargar borrador
        </a>
      </div>

      {error && (
        <div className="rounded-md bg-rose-50 border border-rose-200 px-3 py-2 text-sm text-rose-900">
          {error}
        </div>
      )}

      <p className="text-xs text-slate-500">
        Generar y enviar genera el contrato y se lo manda al técnico por
        WhatsApp en una sola acción. Cuando el técnico devuelva el firmado
        (foto o PDF), súbelo aquí — automáticamente queda como firmado.
      </p>
    </div>
  );
}
