// Contract draft PDF preview. Streams the same PDF that "Generar y enviar"
// would produce — used by HR's quick-preview link, NOT by the workflow itself.
// The real generation/upload/send path lives in the generateAndSend server
// action, which calls the same generateAndUploadContractPdf helper.

import { NextResponse } from "next/server";
import { serverClientBoundToCookies, serviceClient } from "@/lib/supabase-server";
import { generateAndUploadContractPdf } from "@/lib/contract-pdf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: { id: string } }
) {
  const auth = serverClientBoundToCookies();
  const { data: userData } = await auth.auth.getUser();
  if (!userData.user) {
    return NextResponse.json({ error: "auth required" }, { status: 401 });
  }

  const supa = serviceClient();
  const { data: contract, error } = await supa
    .from("contratos")
    .select("id, tecnico_id, ot_id, created_by")
    .eq("id", params.id)
    .maybeSingle();
  if (error || !contract) {
    return NextResponse.json({ error: "contract not found" }, { status: 404 });
  }

  const { buffer } = await generateAndUploadContractPdf(supa, contract);

  // Wrap the PDF bytes in a Blob — Blob is universally accepted as BodyInit
  // across Node's Response and the DOM Response types. Buffer/Uint8Array
  // generic flavors trip up TS5 DOM libs depending on version drift.
  const blob = new Blob([new Uint8Array(buffer)], { type: "application/pdf" });
  return new Response(blob, {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="contrato-${contract.id.slice(0, 8)}.pdf"`,
    },
  });
}
