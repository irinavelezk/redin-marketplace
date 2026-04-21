// Apply CTA: shows a redacted summary of the OT plus a WhatsApp deep-link that
// pre-fills a message with the OT id, so Toño sees it and can call create_postulacion.

import { serviceClient } from "@/lib/supabase-server";
import { redactForPublic } from "@/lib/redact";
import { buildWaLink } from "@/lib/wa-link";
import Link from "next/link";
import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

function descripcionFrom(data: unknown): string {
  if (!data || typeof data !== "object" || Array.isArray(data)) return "";
  const d = data as Record<string, unknown>;
  for (const k of ["Descripcion", "descripcion", "Resumen Visual", "Actividad_Descripcion"]) {
    const v = d[k];
    if (typeof v === "string" && v.trim().length > 0) return v.trim();
  }
  return "";
}

interface Props {
  params: { ot_id: string };
}

export default async function AplicarPage({ params }: Props) {
  const otId = decodeURIComponent(params.ot_id);
  const supa = serviceClient();
  const { data: ot, error } = await supa
    .from("ots_mirror")
    .select("row_id, ciudad, especialidad, estado, data")
    .eq("row_id", otId)
    .maybeSingle();
  if (error) {
    return <div className="card p-6 text-red-700">Error: {error.message}</div>;
  }
  if (!ot) notFound();

  const waText = `Hola Toño, me interesa el trabajo OT ${otId} en ${ot.ciudad ?? "Colombia"}. ¿Qué sigue?`;

  return (
    <div className="max-w-xl mx-auto space-y-4">
      <Link href="/" className="text-sm text-slate-500 hover:text-slate-700">
        ← volver
      </Link>
      <div className="card p-6">
        <div className="text-sm text-slate-500">
          {ot.ciudad ?? "Colombia"} · {ot.especialidad ?? "mantenimiento"}
        </div>
        <h1 className="text-xl font-semibold text-slate-900 mt-1">
          {(ot.estado ?? "Trabajo abierto").replace(/^[\d. ]+/, "")}
        </h1>
        <p className="mt-3 text-slate-700">
          {redactForPublic(descripcionFrom(ot.data), 400)}
        </p>
        <p className="mt-4 text-sm text-slate-500">
          Aplicar es rápido. Le escribes a Toño por WhatsApp y él te registra si
          aún no estás en el sistema. Si ya estás, te aplica a este trabajo en
          segundos.
        </p>
        <a
          href={buildWaLink({ text: waText })}
          target="_blank"
          rel="noreferrer"
          className="mt-4 inline-flex items-center bg-amber-500 hover:bg-amber-600 text-white font-medium rounded-md px-4 py-2 transition"
        >
          Escribir a Toño
        </a>
      </div>
    </div>
  );
}
