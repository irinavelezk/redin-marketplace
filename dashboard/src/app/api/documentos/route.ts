// /api/documentos — record an already-uploaded document. Called from the
// browser upload flow after it PUTs the file directly to Supabase Storage.

import { NextResponse } from "next/server";
import { makeDefaultToolContext, uploadDocumento } from "@redin/tools";
import { createServerClient } from "@redin/shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const { tecnico_id, tipo, filename, storage_path } = (body ?? {}) as {
    tecnico_id?: string;
    tipo?: string;
    filename?: string;
    storage_path?: string;
  };
  if (!tecnico_id || !tipo || !filename || !storage_path) {
    return NextResponse.json(
      { error: "tecnico_id, tipo, filename, storage_path required" },
      { status: 400 }
    );
  }
  const toolCtx = makeDefaultToolContext({
    supabase: createServerClient(),
    defaultActor: `tecnico:${tecnico_id}`,
  });
  const res = await uploadDocumento(toolCtx, {
    tecnico_id,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tipo: tipo as any,
    filename,
    storage_path,
  });
  if (!res.ok) {
    return NextResponse.json({ error: res.error, code: res.code }, { status: 400 });
  }
  return NextResponse.json(res.data);
}
