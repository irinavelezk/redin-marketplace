// Magic-link email login (Supabase Auth). Used by HR primarily.
// Técnicos can use the same flow; phone OTP is TODO (Twilio not wired in v1).

"use client";

import { useState } from "react";
import { browserClient } from "@/lib/supabase-browser";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [errMsg, setErrMsg] = useState("");

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setStatus("sending");
    setErrMsg("");
    const supa = browserClient();
    const { error } = await supa.auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo:
          typeof window !== "undefined"
            ? `${window.location.origin}/auth/callback?next=/hr/pipeline`
            : undefined,
      },
    });
    if (error) {
      setErrMsg(error.message);
      setStatus("error");
      return;
    }
    setStatus("sent");
  }

  return (
    <div className="max-w-sm mx-auto space-y-4">
      <h1 className="text-xl font-semibold text-slate-900">Entrar</h1>
      <p className="text-sm text-slate-600">
        Te enviamos un enlace mágico a tu correo. Click y entras — sin contraseñas.
      </p>
      {status === "sent" ? (
        <div className="card p-4 text-slate-700 text-sm">
          Listo. Revisa tu correo y toca el enlace para entrar.
        </div>
      ) : (
        <form onSubmit={onSubmit} className="card p-4 space-y-3">
          <label className="block text-sm">
            Correo
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="mt-1 w-full border border-slate-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-400"
              placeholder="tu@correo.com"
            />
          </label>
          <button
            type="submit"
            disabled={status === "sending"}
            className="w-full bg-amber-500 hover:bg-amber-600 disabled:opacity-60 text-white rounded-md px-3 py-2 text-sm font-medium"
          >
            {status === "sending" ? "Enviando…" : "Enviar enlace"}
          </button>
          {status === "error" && (
            <div className="text-red-700 text-sm">{errMsg}</div>
          )}
        </form>
      )}
      <div className="text-xs text-slate-500">
        Para técnicos: el canal oficial es WhatsApp con Toño. Esta página es
        principalmente para el equipo de HR.
      </div>
    </div>
  );
}
