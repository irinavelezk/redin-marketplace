// Email-OTP login (Supabase Auth). Used by HR primarily.
// We deliberately don't use the magic-link click flow because Gmail and
// corporate mail scanners pre-fetch links to render previews, and that
// pre-fetch consumes the single-use token before the user clicks. Banks
// and GitHub use 6-digit codes for the same reason. Técnicos can use the
// same flow; phone OTP is TODO (Twilio not wired in v1).

"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { browserClient } from "@/lib/supabase-browser";

const URL_ERROR_MESSAGES: Record<string, string> = {
  invalid_or_expired_link:
    "El código expiró o ya se usó. Pide uno nuevo abajo.",
  otp_expired:
    "El código expiró. Pide uno nuevo abajo.",
  access_denied:
    "El código ya no es válido. Pide uno nuevo abajo.",
};

function LoginInner() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const [step, setStep] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [status, setStatus] = useState<"idle" | "sending" | "verifying" | "error">("idle");
  const [errMsg, setErrMsg] = useState("");
  const [urlError, setUrlError] = useState<string | null>(null);

  useEffect(() => {
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

  async function sendCode(e: React.FormEvent) {
    e.preventDefault();
    setStatus("sending");
    setErrMsg("");
    const supa = browserClient();
    const { error } = await supa.auth.signInWithOtp({
      email,
      options: { shouldCreateUser: false },
    });
    if (error) {
      setErrMsg(translateAuthError(error.message));
      setStatus("error");
      return;
    }
    setStep("code");
    setStatus("idle");
    setUrlError(null);
  }

  async function verifyCode(e: React.FormEvent) {
    e.preventDefault();
    setStatus("verifying");
    setErrMsg("");
    const supa = browserClient();
    const { error } = await supa.auth.verifyOtp({
      email,
      token: code.trim(),
      type: "email",
    });
    if (error) {
      setErrMsg(translateAuthError(error.message));
      setStatus("error");
      return;
    }
    // Session cookies are set client-side by supabase-js; refresh server state.
    router.replace("/hr/pipeline");
    router.refresh();
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
      return "El código expiró. Pide uno nuevo.";
    }
    if (m.includes("token") || m.includes("otp") || m.includes("invalid")) {
      return "Código incorrecto. Revísalo y vuelve a intentar.";
    }
    if (m.includes("user not found") || m.includes("not found")) {
      return "Ese correo no está registrado como usuario de Redin.";
    }
    return msg;
  }

  return (
    <div className="max-w-sm mx-auto space-y-4">
      <h1 className="text-xl font-semibold text-slate-900">Entrar</h1>
      <p className="text-sm text-slate-600">
        Te enviamos un código de 6 dígitos al correo. Lo escribes acá y entras —
        sin contraseñas, sin links que se vencen al pasar el cursor.
      </p>
      {urlError && step === "email" && (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          {urlError}
        </div>
      )}
      {step === "email" ? (
        <form onSubmit={sendCode} className="card p-4 space-y-3">
          <label className="block text-sm">
            Correo
            <input
              type="email"
              required
              autoFocus
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
            {status === "sending" ? "Enviando…" : "Enviar código"}
          </button>
          {status === "error" && (
            <div className="text-red-700 text-sm">{errMsg}</div>
          )}
        </form>
      ) : (
        <form onSubmit={verifyCode} className="card p-4 space-y-3">
          <div className="text-sm text-slate-600">
            Código enviado a <span className="font-medium">{email}</span>.
            Revisa tu correo (incluida la carpeta de spam).
          </div>
          <label className="block text-sm">
            Código
            <input
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]*"
              required
              autoFocus
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              className="mt-1 w-full border border-slate-300 rounded-md px-3 py-2 text-lg tracking-widest font-mono text-center focus:outline-none focus:ring-2 focus:ring-amber-400"
              placeholder="123456"
              maxLength={6}
            />
          </label>
          <button
            type="submit"
            disabled={status === "verifying" || code.length < 6}
            className="w-full bg-amber-500 hover:bg-amber-600 disabled:opacity-60 text-white rounded-md px-3 py-2 text-sm font-medium"
          >
            {status === "verifying" ? "Verificando…" : "Entrar"}
          </button>
          <button
            type="button"
            onClick={() => {
              setStep("email");
              setCode("");
              setErrMsg("");
              setStatus("idle");
            }}
            className="w-full text-xs text-slate-500 hover:text-slate-700"
          >
            ← cambiar correo / pedir otro código
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
  return (
    <Suspense fallback={null}>
      <LoginInner />
    </Suspense>
  );
}
