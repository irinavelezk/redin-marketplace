// Embedded chat API — same agent as WhatsApp, channel=dashboard.
// POST { phone, text } → { reply, session_id, tool_calls }
//
// Auth: we allow unauth'd sessions (the landing page "dashboard chat" widget)
// because identifying by phone is the point. For HR's view of user sessions
// we'll gate later with Supabase Auth + role check.

import { NextResponse } from "next/server";
import { handleMessage } from "@redin/tono";
import { makeDefaultToolContext, type Actor } from "@redin/tools";
import { createServerClient, normalizePhone } from "@redin/shared";
import { TelegramEscalationSink } from "@redin/tono";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "body must be object" }, { status: 400 });
  }
  const { phone, text } = body as { phone?: unknown; text?: unknown };
  if (typeof phone !== "string" || !phone.trim()) {
    return NextResponse.json({ error: "phone required" }, { status: 400 });
  }
  if (typeof text !== "string" || !text.trim()) {
    return NextResponse.json({ error: "text required" }, { status: 400 });
  }
  const normalized = normalizePhone(phone);
  if (!normalized) {
    return NextResponse.json({ error: "invalid phone" }, { status: 400 });
  }
  const actor: Actor = `tecnico:${normalized}`;
  try {
    const toolCtx = makeDefaultToolContext({
      supabase: createServerClient(),
      defaultActor: actor,
      escalationSink: TelegramEscalationSink.fromEnv(),
    });
    const result = await handleMessage({
      phone: normalized,
      text,
      channel: "dashboard",
      toolCtx,
    });
    return NextResponse.json({
      reply: result.reply,
      session_id: result.session_id,
      tool_calls: result.tool_calls,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[api/chat] failed:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
