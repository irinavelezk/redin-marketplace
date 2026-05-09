// Contract PDF generator and uploader. Used by the GET /api/contract/[id]/draft
// route (HR's preview download) AND by the generateAndSend server action
// (one-click "Generar y enviar"). Extracting it from the route handler is what
// lets us collapse the contract flow from 5 buttons to 2.
//
// The PDF body is the Colombian "prestación de servicios" template — Código
// Civil + Art. 34 CST, 4-year max duration, 40% min IBC. See the full
// reference in the route file's original commit.

import "server-only";

import {
  pdf,
  Document,
  Page,
  Text,
  View,
  StyleSheet,
} from "@react-pdf/renderer";
import { Readable } from "node:stream";
import React from "react";
import type { SupabaseClient } from "@supabase/supabase-js";

const styles = StyleSheet.create({
  page: { padding: 48, fontSize: 10.5, fontFamily: "Helvetica", lineHeight: 1.45 },
  h1: { fontSize: 14, marginBottom: 4, fontWeight: "bold", textAlign: "center" },
  sub: { fontSize: 9, color: "#475569", marginBottom: 14, textAlign: "center" },
  h2: { fontSize: 11, marginTop: 10, marginBottom: 4, fontWeight: "bold" },
  p: { marginBottom: 5, textAlign: "justify" },
  kv: { marginBottom: 2 },
  list: { marginLeft: 14, marginBottom: 4 },
  listItem: { marginBottom: 2 },
  signatures: {
    marginTop: 24,
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 32,
  },
  sigBlock: { flex: 1 },
  sigLine: {
    borderTopWidth: 1,
    borderTopColor: "#0f172a",
    marginTop: 28,
    marginBottom: 4,
  },
  foot: {
    marginTop: 18,
    fontSize: 8.5,
    color: "#475569",
    borderTopWidth: 1,
    borderTopColor: "#e2e8f0",
    paddingTop: 8,
  },
});

interface DocProps {
  tecnicoId: string;
  tecnicoNombre: string | null;
  otId: string | null;
  contractId: string;
  ciudad: string;
  especialidad: string;
  descripcion: string;
  createdBy: string;
  createdAtIso: string;
}

function clause(num: string, title: string, body: string) {
  return [
    React.createElement(Text, { key: `${num}-h`, style: styles.h2 }, `${num}. ${title.toUpperCase()}`),
    React.createElement(Text, { key: `${num}-b`, style: styles.p }, body),
  ];
}

function listClause(num: string, title: string, lead: string, items: string[]) {
  return [
    React.createElement(Text, { key: `${num}-h`, style: styles.h2 }, `${num}. ${title.toUpperCase()}`),
    React.createElement(Text, { key: `${num}-l`, style: styles.p }, lead),
    React.createElement(
      View,
      { key: `${num}-list`, style: styles.list },
      ...items.map((it, i) =>
        React.createElement(Text, { key: `${num}-${i}`, style: styles.listItem }, `• ${it}`)
      )
    ),
  ];
}

function ContractDoc(p: DocProps) {
  const fechaLegible = new Date(p.createdAtIso).toLocaleDateString("es-CO", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
  const lugarEjecucion = p.ciudad?.trim() || "Colombia";
  const especialidad = p.especialidad?.trim() || "mantenimiento técnico";
  const objetoBase =
    p.descripcion?.trim() ||
    "los servicios técnicos descritos en la OT y su cotización aprobada";

  return React.createElement(
    Document,
    null,
    React.createElement(
      Page,
      { size: "LETTER", style: styles.page },

      React.createElement(Text, { style: styles.h1 }, "CONTRATO DE PRESTACIÓN DE SERVICIOS"),
      React.createElement(
        Text,
        { style: styles.sub },
        `Documento ${p.contractId.slice(0, 8)} · Suscrito en ${lugarEjecucion}, ${fechaLegible}`
      ),

      React.createElement(Text, { style: styles.h2 }, "PARTES"),
      React.createElement(
        Text,
        { style: styles.p },
        `El presente contrato se celebra entre REDIN — RED DE INGENIEROS NACIONAL S.A.S., en adelante el CONTRATANTE, identificada con NIT registrado en sus archivos comerciales y domiciliada en Cali (Valle del Cauca, Colombia); y ${p.tecnicoNombre ?? "el técnico identificado en este documento"}${p.tecnicoNombre ? "" : ` (id ${p.tecnicoId.slice(0, 8)})`}, en adelante el CONTRATISTA, mayor de edad, identificado con cédula de ciudadanía a registrar al momento de la firma.`
      ),

      React.createElement(Text, { style: styles.h2 }, "ANTECEDENTES"),
      React.createElement(
        Text,
        { style: styles.p },
        "El CONTRATANTE opera como gestor de servicios de mantenimiento técnico para clientes empresariales en Colombia. El CONTRATISTA declara contar con la experiencia, herramientas y conocimientos técnicos para prestar los servicios objeto de este contrato y manifiesta su voluntad de hacerlo en forma independiente, con plena autonomía."
      ),

      ...clause(
        "1ª",
        "Objeto",
        `El CONTRATISTA se obliga, de manera autónoma e independiente, a ejecutar ${objetoBase}, correspondiente a la OT ${p.otId ?? "(por asignar)"}, en la especialidad de ${especialidad}, conforme a la cotización aprobada por las partes y a las normas técnicas aplicables.`
      ),

      ...clause(
        "2ª",
        "Plazo",
        "El presente contrato regirá desde la fecha de firma y hasta la entrega y aprobación final del objeto. Cualquier prórroga será por mutuo acuerdo escrito y, en todo caso, no excederá los cuatro (4) años en cumplimiento de la normativa vigente sobre contratos de prestación de servicios."
      ),

      ...clause(
        "3ª",
        "Lugar de Ejecución",
        `Los servicios se ejecutarán en ${lugarEjecucion} y/o en los sitios coordinados con el CONTRATANTE para el cumplimiento del objeto.`
      ),

      ...clause(
        "4ª",
        "Valor y Forma de Pago",
        "El valor total será el establecido en la cotización aprobada por las partes para esta OT. La modalidad es TODO COSTO: el CONTRATISTA suministra mano de obra, herramienta y materiales aprobados. El pago se realizará contra entrega, aprobación de calidad por parte del CONTRATANTE y presentación de la cuenta de cobro o factura electrónica por el CONTRATISTA, conforme a la normativa tributaria vigente."
      ),

      ...clause(
        "5ª",
        "Naturaleza y Autonomía",
        "Este contrato es de naturaleza civil, regido por el Código Civil Colombiano. NO genera vínculo laboral entre las partes. El CONTRATISTA actúa con plena autonomía técnica, administrativa y financiera en los términos del Artículo 34 del Código Sustantivo del Trabajo, sin sujeción a horarios, subordinación ni dirección permanente del CONTRATANTE."
      ),

      ...listClause(
        "6ª",
        "Obligaciones del Contratista",
        "El CONTRATISTA se obliga a:",
        [
          "Ejecutar los servicios con la calidad técnica esperada y dentro de los plazos pactados.",
          "Mantener afiliación vigente al Sistema General de Seguridad Social en Salud, Pensión y Riesgos Laborales (ARL Clase IV o V según aplique a la actividad), siendo el CONTRATISTA quien asume el pago de aportes con base en la mínima del 40 % del valor mensual del contrato conforme a la norma vigente desde 2025.",
          "Cumplir las normas de seguridad industrial, salud ocupacional y uso de elementos de protección personal aplicables al trabajo.",
          "Suministrar la herramienta y los materiales aprobados en la cotización.",
          "Guardar absoluta confidencialidad sobre clientes, ubicaciones, información técnica, comercial y operativa a la que acceda con ocasión del contrato.",
          "Responder por la calidad de la obra y atender, sin costo adicional, los ajustes razonables identificados durante la entrega.",
        ]
      ),

      ...listClause(
        "7ª",
        "Obligaciones del Contratante",
        "El CONTRATANTE se obliga a:",
        [
          "Pagar el valor pactado en la forma, tiempos y condiciones acordados.",
          "Suministrar al CONTRATISTA la información técnica y de acceso necesaria para la ejecución.",
          "Coordinar el ingreso al sitio de trabajo y emitir las aprobaciones de avance y entrega.",
        ]
      ),

      ...clause(
        "8ª",
        "Causales de Terminación",
        "El contrato terminará por cualquiera de las siguientes causas: (i) cumplimiento del objeto; (ii) mutuo acuerdo escrito; (iii) incumplimiento grave de cualquiera de las partes; (iv) fuerza mayor o caso fortuito; o (v) decisión unilateral de cualquiera de las partes con preaviso escrito de cinco (5) días hábiles, sin que ello genere indemnización adicional al pago de los servicios efectivamente prestados y aprobados."
      ),

      ...clause(
        "9ª",
        "Indemnidad",
        "El CONTRATISTA mantendrá indemne al CONTRATANTE frente a cualquier reclamación de tipo laboral, parafiscal, fiscal o de seguridad social derivada de la ejecución de este contrato. Cualquier daño causado a terceros con ocasión de la ejecución será de exclusiva responsabilidad del CONTRATISTA."
      ),

      ...clause(
        "10ª",
        "Cesión y Subcontratación",
        "El CONTRATISTA no podrá ceder, total o parcialmente, ni subcontratar las obligaciones de este contrato sin autorización escrita y previa del CONTRATANTE."
      ),

      ...clause(
        "11ª",
        "Confidencialidad",
        "La obligación de confidencialidad sobre información del CONTRATANTE y sus clientes subsistirá durante la vigencia del contrato y por dos (2) años posteriores a su terminación, por cualquier causa."
      ),

      ...clause(
        "12ª",
        "Domicilio",
        "Para todos los efectos del presente contrato, el domicilio contractual será la ciudad de Cali, Valle del Cauca, Colombia."
      ),

      ...clause(
        "13ª",
        "Solución de Controversias",
        "Las controversias derivadas del presente contrato serán resueltas, en primera instancia, mediante conciliación en un centro legalmente autorizado y, en su defecto, por la justicia ordinaria competente conforme a las leyes colombianas."
      ),

      React.createElement(Text, { style: styles.h2 }, "FIRMAS"),
      React.createElement(
        View,
        { style: styles.signatures },
        React.createElement(
          View,
          { style: styles.sigBlock },
          React.createElement(Text, { style: styles.kv }, "Por el CONTRATANTE — Redin S.A.S."),
          React.createElement(View, { style: styles.sigLine }),
          React.createElement(Text, { style: styles.kv }, "Nombre: __________________________"),
          React.createElement(Text, { style: styles.kv }, "C.C.: ____________________________"),
          React.createElement(Text, { style: styles.kv }, "Cargo: ___________________________")
        ),
        React.createElement(
          View,
          { style: styles.sigBlock },
          React.createElement(Text, { style: styles.kv }, "Por el CONTRATISTA"),
          React.createElement(View, { style: styles.sigLine }),
          React.createElement(
            Text,
            { style: styles.kv },
            `Nombre: ${p.tecnicoNombre ?? "__________________________"}`
          ),
          React.createElement(Text, { style: styles.kv }, "C.C.: ____________________________"),
          React.createElement(Text, { style: styles.kv }, "Fecha de firma: ___________________")
        )
      ),

      React.createElement(
        Text,
        { style: styles.foot },
        `Borrador generado automáticamente por la plataforma Redin Marketplace el ${fechaLegible} (id ${p.contractId.slice(0, 8)}, generado por ${p.createdBy}). La firma electrónica simple se admite en los términos de la Ley 527 de 1999 y demás normas concordantes; las cifras y descripciones específicas vinculan a las partes una vez firmado por ambas.`
      )
    )
  );
}

async function readableToBuffer(s: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of s) {
    chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  }
  return Buffer.concat(chunks);
}

interface ContextRow {
  ot_id: string | null;
  tecnico_id: string;
  created_by: string | null;
}

// Renders the PDF for a contract row, uploads it to the `contratos` bucket
// at `${contractId}/draft.pdf` (upsert), updates the contrato row's
// pdf_storage_path. Returns the bytes so the caller can also stream them
// back to the browser if they want (the GET /draft route does).
export async function generateAndUploadContractPdf(
  supa: SupabaseClient,
  contract: ContextRow & { id: string }
): Promise<{ buffer: Buffer; storagePath: string }> {
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
    for (const k of [
      "Descripcion",
      "descripcion",
      "Resumen Visual",
      "Actividad_Descripcion",
    ]) {
      const v = d[k];
      if (typeof v === "string" && v.trim().length > 0) {
        descripcion = v.trim();
        break;
      }
    }
  }

  // Pull tecnico nombre from the latest tecnico_registered event meta — same
  // source identify_user uses, so the contract matches what Toño calls them.
  let tecnicoNombre: string | null = null;
  const { data: regEvent } = await supa
    .from("eventos")
    .select("meta")
    .eq("type", "tecnico_registered")
    .eq("entity_id", contract.tecnico_id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (
    regEvent?.meta &&
    typeof regEvent.meta === "object" &&
    !Array.isArray(regEvent.meta)
  ) {
    const v = (regEvent.meta as Record<string, unknown>).nombre;
    if (typeof v === "string" && v.trim().length > 0) tecnicoNombre = v.trim();
  }

  const doc = ContractDoc({
    tecnicoId: contract.tecnico_id,
    tecnicoNombre,
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

  const storagePath = `${contract.id}/draft.pdf`;
  await supa.storage.from("contratos").upload(storagePath, buf, {
    contentType: "application/pdf",
    upsert: true,
  });
  await supa
    .from("contratos")
    .update({ pdf_storage_path: storagePath })
    .eq("id", contract.id);

  return { buffer: buf, storagePath };
}
