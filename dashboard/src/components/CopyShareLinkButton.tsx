// Tiny client-only button that copies a public URL to the clipboard. Used
// from the pipeline to share an OT view with an architect — the link itself
// is built server-side via signOtPublicToken.

"use client";

import { useState } from "react";

export function CopyShareLinkButton({
  url,
  label = "Compartir con arquitecto",
  copiedLabel = "✓ Copiado",
}: {
  url: string;
  label?: string;
  copiedLabel?: string;
}): JSX.Element {
  const [copied, setCopied] = useState(false);

  async function onClick(): Promise<void> {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard write can fail in non-https iframes — fall back to prompt.
      window.prompt("Copia este enlace:", url);
    }
  }

  return (
    <button
      type="button"
      onClick={onClick}
      className="text-xs text-slate-600 hover:text-slate-900 underline-offset-2 hover:underline"
    >
      {copied ? copiedLabel : label}
    </button>
  );
}
