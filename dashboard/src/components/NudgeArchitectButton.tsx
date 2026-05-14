// Client button that POST /api/hr/nudge-architect with { ot_id }.
// Shows inline feedback on success/error. Used from /hr/pipeline for OTs
// that lack alcance (ots_extended row with no alcance_jsonb).

"use client";

import { useState } from "react";

export function NudgeArchitectButton({
  otId,
}: {
  otId: string;
}): JSX.Element {
  const [status, setStatus] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  async function onClick(): Promise<void> {
    if (status === "loading" || status === "done") return;
    setStatus("loading");
    setErrorMsg(null);
    try {
      const resp = await fetch("/api/hr/nudge-architect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ot_id: otId }),
      });
      if (!resp.ok) {
        const data = (await resp.json()) as { error?: string };
        setErrorMsg(data?.error ?? `Error ${resp.status}`);
        setStatus("error");
        return;
      }
      setStatus("done");
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "Error desconocido");
      setStatus("error");
    }
  }

  if (status === "done") {
    return (
      <span className="text-xs text-emerald-600 font-medium">
        Mensaje enviado al arquitecto
      </span>
    );
  }

  return (
    <div className="flex flex-col items-start gap-0.5">
      <button
        type="button"
        onClick={onClick}
        disabled={status === "loading"}
        className="text-xs text-slate-600 hover:text-slate-900 disabled:opacity-50 underline-offset-2 hover:underline flex items-center gap-1"
      >
        {status === "loading" ? "Enviando…" : "Pedir alcance al arquitecto"}
      </button>
      {status === "error" && errorMsg && (
        <span className="text-[11px] text-red-600">{errorMsg}</span>
      )}
    </div>
  );
}
