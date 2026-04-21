// Contract draft PDF generator. Renders a minimal prestación-de-servicios
// template with técnico + OT data and streams it back as a downloadable PDF.
// Also uploads the same bytes to Supabase Storage (contratos bucket) and
// updates the contrato row with `pdf_storage_path` so HR can retrieve later.

import { NextResponse } from "next/server";
import { serverClientBoundToCookies, serviceClient } from "@/lib/supabase-server";
import { pdf, Document, Page, Text, View, StyleSheet } from "@react-pdf/renderer";
import { Readable } from "node:stream";
import React from "react";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const styles = StyleSheet.create({
  page: { padding: 40, fontSize: 11, fontFamily: "Helvetica" },
  h1: { fontSize: 16, marginBottom: 14, fontWeight: "bold" },
  h2: { fontSize: 12, marginTop: 12, marginBottom: 6, fontWeight: "bold" },
  p: { marginBottom: 6, lineHeight: 1.4 },
  kv: { marginBottom: 2 },
  foot: { marginTop: 24, fontSize: 9, color: "#475569" },
});

interface Props {
  tecnicoId: string;
  otId: string | null;
  contractId: string;
  ciudad: string;
  especialidad: string;
  descripcion: string;
  createdBy: string;
  createdAtIso: string;
}

function ContractDoc(p: Props) {
  return React.createElement(
    Document,
    null,
    React.createElement(
      Page,
      { size: "LETTER", style: styles.page },
      React.createElement(Text, { style: styles.h1 }, "Contrato de prestación de servicios — Redin"),
      React.createElement(Text, { style: styles.p }, `Documento: ${p.contractId}`),
      React.createElement(Text, { style: styles.p }, `Fecha: ${new Date(p.createdAtIso).toLocaleString("es-CO")}`),
      React.createElement(Text, { style: styles.p }, `Generado por: ${p.createdBy}`),

      React.createElement(Text, { style: styles.h2 }, "Partes"),
      React.createElement(
        Text,
        { style: styles.p },
        `Contratante: Redin — Red de Ingenieros Nacional. NIT en archivo.`
      ),
      React.createElement(Text, { style: styles.p }, `Contratista (técnico): ${p.tecnicoId}`),

      React.createElement(Text, { style: styles.h2 }, "Objeto"),
      React.createElement(
        Text,
        { style: styles.p },
        `Ejecución de trabajos de mantenimiento conforme a la OT ${p.otId ?? "(sin asignar)"} en la ciudad de ${p.ciudad || "Colombia"}. Especialidad: ${p.especialidad || "mantenimiento"}.`
      ),
      React.createElement(Text, { style: styles.p }, p.descripcion || "Descripción pendiente."),

      React.createElement(Text, { style: styles.h2 }, "Naturaleza"),
      React.createElement(
        Text,
        { style: styles.p },
        "Este contrato es de prestación de servicios en los términos del Código Civil Colombiano. No existe subordinación laboral, no hay vínculo de empleo, y el contratista asume su seguridad social y ARL."
      ),

      React.createElement(Text, { style: styles.h2 }, "Modalidad"),
      React.createElement(
        Text,
        { style: styles.p },
        "Todo costo: el contratista lleva herramienta y materiales, los cuales deben estar aprobados en la cotización correspondiente. Pago contra entrega, aprobación y facturación por parte del contratante."
      ),

      React.createElement(Text, { style: styles.h2 }, "Firmas"),
      React.createElement(
        View,
        { style: { marginTop: 20 } },
        React.createElement(Text, { style: styles.kv }, "Por Redin: _________________________________"),
        React.createElement(Text, { style: styles.kv }, "Por el contratista: _______________________"),
      ),

      React.createElement(
        Text,
        { style: styles.foot },
        `Este PDF es un borrador generado automáticamente. La firma electrónica se formalizará según Ley 527 / firma digital simple.`
      )
    )
  );
}

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const auth = serverClientBoundToCookies();
  const { data: userData } = await auth.auth.getUser();
  if (!userData.user) {
    return NextResponse.json({ error: "auth required" }, { status: 401 });
  }

  const supa = serviceClient();
  const { data: contract, error } = await supa
    .from("contratos")
    .select("*")
    .eq("id", params.id)
    .maybeSingle();
  if (error || !contract) {
    return NextResponse.json({ error: "contract not found" }, { status: 404 });
  }
  const { data: ot } = contract.ot_id
    ? await supa
        .from("ots_mirror")
        .select("ciudad, especialidad, data")
        .eq("row_id", contract.ot_id)
        .maybeSingle()
    : { data: null };

  let descripcion = "";
  if (ot?.data && typeof ot.data === "object" && !Array.isArray(ot.data)) {
    const d = ot.data as Record<string, unknown>;
    for (const k of ["Descripcion", "descripcion", "Resumen Visual"]) {
      const v = d[k];
      if (typeof v === "string" && v.trim().length > 0) {
        descripcion = v.trim();
        break;
      }
    }
  }

  const doc = ContractDoc({
    tecnicoId: contract.tecnico_id,
    otId: contract.ot_id,
    contractId: contract.id,
    ciudad: ot?.ciudad ?? "",
    especialidad: ot?.especialidad ?? "",
    descripcion,
    createdBy: contract.created_by ?? "sistema",
    createdAtIso: new Date().toISOString(),
  });

  const stream = await pdf(doc).toBuffer();
  const buf = await readableToBuffer(stream as unknown as Readable);

  // Upload a copy to Storage so HR can fetch the exact draft later.
  const storagePath = `${contract.id}/draft.pdf`;
  await supa.storage.from("contratos").upload(storagePath, buf, {
    contentType: "application/pdf",
    upsert: true,
  });
  await supa
    .from("contratos")
    .update({ pdf_storage_path: storagePath })
    .eq("id", contract.id);

  // Wrap the PDF bytes in a Blob — Blob is universally accepted as BodyInit
  // across Node's Response and the DOM Response types. Buffer/Uint8Array
  // generic flavors trip up TS5 DOM libs depending on version drift.
  const blob = new Blob([new Uint8Array(buf)], { type: "application/pdf" });
  return new Response(blob, {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="contrato-${contract.id.slice(0, 8)}.pdf"`,
    },
  });
}

async function readableToBuffer(s: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of s) {
    chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  }
  return Buffer.concat(chunks);
}
