// Magic-link email login (Supabase Auth). Used by HR primarily.
// Técnicos can use the same flow; phone OTP is TODO (Twilio not wired in v1).

"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { browserClient } from "@/lib/supabase-browser";

const URL_ERROR_MESSAGES: Record<string, string> = {
  invalid_or_expired_link:
    "El enlace expiró o ya se usó. Pide uno nuevo abajo — los enlaces duran 24 horas y solo sirven una vez.",
  otp_expired:
    "El enlace expiró. Pide uno nuevo abajo.",
  access_denied:
    "El enlace ya no es válido. Pide uno nuevo abajo.",
};

function LoginInner() {
  const searchParams = useSearchParams();
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [errMsg, setErrMsg] = useState("");
  const [urlError, setUrlError] = useState<string | null>(null);

  useEffect(() => {
    // Surface ?error=... (set by /auth/callback when verify fails) AND any
    // Supabase-set hash error (#error_code=...) so the user knows why they
    // landed back here. Without this the page silently shows a blank form.
    const queryErr = searchParams.get("error");
    let hashErr: string | null = null;
    if (typeof window !== "undefined" && window.location.hash) {
      const params = new URLSearchParams(window.location.hash.slice(1));
      hashErr = params.get("error_code") || params.get("error");
    }
    const code = queryErr || hashErr;
    if (code) {
      setUrlError(URL_ERROR_MESSAGES[code] ?? `Hubo un problema con el enlace (${code}).`);
    }
  }, [searchParams]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setStatus("sending");
    setErrMsg("");
    const supa = browserClient();
    // Always send emails with the canonical production URL so a stale local
    // dev server cannot hijack the redirect target. NEXT_PUBLIC_SITE_URL is
    // set by Railway; the literal fallback covers `npm run dev` without env.
    const siteUrl =
      process.env.NEXT_PUBLIC_SITE_URL ||
      "https://dashboard-mp-production.up.railway.app";
    const { error } = await supa.auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: `${siteUrl}/auth/callback?next=/hr/pipeline`,
      },
    });
    if (error) {
      setErrMsg(translateAuthError(error.message));
      setStatus("error");
      return;
    }
    setStatus("sent");
  }

  function translateAuthError(msg: string): string {
    const m = msg.toLowerCase();
    if (m.includes("rate limit")) {
      return "Demasiados intentos. Espera unos minutos y vuelve a intentar.";
    }
    if (m.includes("invalid email") || m.includes("email address")) {
      return "Ese correo no parece válido. Revisa y vuelve a intentar.";
    }
    if (m.includes("expired")) {
      return "El enlace expiró. Pide uno nuevo.";
    }
    return msg;
  }

  return (
    <div className="max-w-sm mx-auto space-y-4">
      <h1 className="text-xl font-semibold text-slate-900">Entrar</h1>
      <p className="text-sm text-slate-600">
        Te enviamos un enlace mágico a tu correo. Click y entras — sin contraseñas.
      </p>
      {urlError && (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          {urlError}
        </div>
      )}
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

export default function LoginPage() {
  // useSearchParams must be inside a Suspense boundary in the App Router
  // when used in a "use client" page; wrapping here keeps the component tree
  // simple and lets Next.js statically prerender the shell.
  return (
    <Suspense fallback={null}>
      <LoginInner />
    </Suspense>
  );
}
