// POST /api/hr/nudge-architect
// Body: { ot_id: string }
//
// Resolves the architect assigned to an OT, finds their WA phone from
// arquitectos_mirror, and enqueues a WA outbound message via the shared
// outbound_messages table with meta.channel = "manos". Manos's outbound
// drainer (Stream A) picks up rows where meta->>channel = "manos".
//
// If Stream A uses a separate table, update this route at integration time.
// Default (constraint spec §6a): reuse outbound_messages with meta.channel="manos".
//
// Auth: requires a valid HR session (Supabase cookie auth).

import { NextResponse } from "next/server";
import { serverClientBoundToCookies, serviceClient } from "@/lib/supabase-server";
import type { Json } from "@redin/shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function getArquitectoPhone(data: Json): string | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const d = data as Record<string, unknown>;
  // Try common field names for architect phone
  for (const k of ["WhatsApp", "Telefono", "telefono", "whatsapp", "Phone"]) {
    const v = d[k];
    if (typeof v === "string" && v.trim().length > 6) return v.trim();
  }
  return null;
}

function getArquitectoNombre(data: Json): string | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const d = data as Record<string, unknown>;
  for (const k of ["Nombre", "nombre", "Name", "name"]) {
    const v = d[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

function getOtDescripcion(data: Json): string | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const d = data as Record<string, unknown>;
  for (const k of ["Descripcion", "descripcion", "Resumen Visual", "Actividad_Descripcion"]) {
    const v = d[k];
    if (typeof v === "string" && v.trim()) return v.trim().slice(0, 80);
  }
  return null;
}

function getArquitectoAsignado(data: Json): string | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const d = data as Record<string, unknown>;
  for (const k of ["Arquitecto_Asignado", "Arquitecto", "arquitecto_asignado"]) {
    const v = d[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

export async function POST(req: Request) {
  // Auth check
  const auth = serverClientBoundToCookies();
  const { data: userData } = await auth.auth.getUser();
  if (!userData.user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const hrEmail = userData.user.email ?? userData.user.id;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "body must be an object" }, { status: 400 });
  }
  const { ot_id } = body as Record<string, unknown>;
  if (typeof ot_id !== "string" || !ot_id.trim()) {
    return NextResponse.json({ error: "ot_id required" }, { status: 400 });
  }

  const supa = serviceClient();

  // 1. Load OT from ots_mirror
  const { data: ot, error: otErr } = await supa
    .from("ots_mirror")
    .select("row_id, data")
    .eq("row_id", ot_id)
    .maybeSingle();
  if (otErr || !ot) {
    return NextResponse.json({ error: "OT not found" }, { status: 404 });
  }

  // 2. Resolve architect row_id from OT data
  const arqRowId = getArquitectoAsignado(ot.data);
  if (!arqRowId) {
    return NextResponse.json(
      { error: "OT has no Arquitecto_Asignado field" },
      { status: 422 }
    );
  }

  // 3. Look up architect in arquitectos_mirror
  const { data: arq, error: arqErr } = await supa
    .from("arquitectos_mirror")
    .select("row_id, data")
    .eq("row_id", arqRowId)
    .maybeSingle();

  if (arqErr || !arq) {
    // Try a case-insensitive match on the data.Nombre field as a fallback
    // (some AppSheet configurations store arq name rather than row_id).
    const { data: arqByName } = await supa
      .from("arquitectos_mirror")
      .select("row_id, data")
      .limit(50);

    const matched = (arqByName ?? []).find((a) => {
      const d = a.data as Record<string, unknown> | null;
      if (!d) return false;
      for (const k of ["Nombre", "nombre", "Name"]) {
        const v = d[k];
        if (typeof v === "string" && v.trim().toLowerCase() === arqRowId.toLowerCase())
          return true;
      }
      return false;
    });

    if (!matched) {
      return NextResponse.json(
        { error: `Architect not found in arquitectos_mirror for arq_row_id: ${arqRowId}` },
        { status: 404 }
      );
    }

    // Use the matched architect
    const phone = getArquitectoPhone(matched.data);
    if (!phone) {
      return NextResponse.json(
        { error: "Architect has no phone in arquitectos_mirror.data" },
        { status: 422 }
      );
    }

    return await enqueueAndRespond({
      supa,
      phone,
      arqNombre: getArquitectoNombre(matched.data),
      otId: ot_id,
      otDesc: getOtDescripcion(ot.data),
      hrEmail,
    });
  }

  // 4. Get architect phone
  const phone = getArquitectoPhone(arq.data);
  if (!phone) {
    return NextResponse.json(
      { error: "Architect has no phone in arquitectos_mirror.data" },
      { status: 422 }
    );
  }

  return await enqueueAndRespond({
    supa,
    phone,
    arqNombre: getArquitectoNombre(arq.data),
    otId: ot_id,
    otDesc: getOtDescripcion(ot.data),
    hrEmail,
  });
}

async function enqueueAndRespond(args: {
  supa: ReturnType<typeof serviceClient>;
  phone: string;
  arqNombre: string | null;
  otId: string;
  otDesc: string | null;
  hrEmail: string;
}): Promise<NextResponse> {
  const { supa, phone, arqNombre, otId, otDesc, hrEmail } = args;

  const nombre = arqNombre ?? "arquitecto";
  const desc = otDesc ?? otId.slice(0, 8);
  const body =
    `Hola ${nombre}, falta el alcance de la OT ${otId.slice(0, 8)} (${desc}). ` +
    `Mándame fotos + voz aquí. (Te identifico por cédula la primera vez.)`;

  // Enqueue to outbound_messages with meta.channel = "manos"
  // Manos's drainer (Stream A) drains rows where meta->>'channel' = 'manos'.
  const { error: enqErr } = await supa.from("outbound_messages").insert({
    phone,
    body,
    channel: "whatsapp",
    kind: "text",
    meta: {
      channel: "manos",
      ot_id: otId,
      triggered_by: `hr:${hrEmail}`,
    },
  });

  if (enqErr) {
    console.error("nudge-architect enqueue failed", { phone, error: enqErr.message });
    return NextResponse.json(
      { error: `Failed to enqueue message: ${enqErr.message}` },
      { status: 500 }
    );
  }

  // Log event
  await supa.from("eventos").insert({
    type: "architect_nudge_sent",
    entity_id: otId,
    actor: `hr:${hrEmail}`,
    meta: { phone, ot_id: otId, arq_nombre: arqNombre },
  });

  return NextResponse.json({ ok: true, phone, ot_id: otId });
}
