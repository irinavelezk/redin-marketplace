// Client button that POSTs to /api/hr/nudge-architect when HR wants to
// prompt an architect to fill in the alcance for an OT that is missing it.
//
// Stream D wires the endpoint (/api/hr/nudge-architect/route.ts). If the
// endpoint doesn't exist yet at integration time, the 404/500 is Stream D's
// responsibility — this button just fires the request.

"use client";

import { useState } from "react";

export function NudgeArchitectButton({ otId }: { otId: string }): JSX.Element {
  const [state, setState] = useState<"idle" | "loading" | "sent" | "error">("idle");

  async function onClick(): Promise<void> {
    setState("loading");
    try {
      const res = await fetch("/api/hr/nudge-architect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ot_id: otId }),
      });
      setState(res.ok ? "sent" : "error");
      if (!res.ok) {
        console.error("nudge-architect failed", res.status, await res.text().catch(() => ""));
      }
    } catch (e) {
      setState("error");
      console.error("nudge-architect error", e);
    }
    // Reset after 4s so the button can be retried.
    setTimeout(() => setState("idle"), 4000);
  }

  const labels: Record<typeof state, string> = {
    idle: "📤 pedir alcance al arquitecto",
    loading: "Enviando...",
    sent: "✓ Arquitecto notificado",
    error: "Error — reintentar",
  };

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={state === "loading" || state === "sent"}
      className={`text-[11px] rounded-full px-2 py-0.5 font-medium disabled:opacity-60 ${
        state === "sent"
          ? "bg-slate-100 text-slate-500"
          : state === "error"
          ? "bg-red-50 text-red-700 hover:bg-red-100"
          : "bg-amber-50 text-amber-700 hover:bg-amber-100"
      }`}
    >
      {labels[state]}
    </button>
  );
}
