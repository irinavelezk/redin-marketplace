// Embedded chat widget — same tool contract as Toño on WhatsApp, channel=dashboard.
// The user types their phone once (we persist in localStorage) then chats.
// Calls /api/chat on each send.

"use client";

import { useEffect, useRef, useState } from "react";

interface Msg {
  role: "user" | "assistant";
  text: string;
}

const LS_KEY = "redin.chat.phone";

export default function ChatWidget() {
  const [open, setOpen] = useState(false);
  const [phone, setPhone] = useState("");
  const [input, setInput] = useState("");
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const saved = typeof window !== "undefined" ? localStorage.getItem(LS_KEY) : "";
    if (saved) setPhone(saved);
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 9e9 });
  }, [msgs]);

  async function send() {
    const text = input.trim();
    if (!text || !phone.trim()) return;
    if (typeof window !== "undefined") localStorage.setItem(LS_KEY, phone.trim());
    setInput("");
    setMsgs((m) => [...m, { role: "user", text }]);
    setBusy(true);
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: phone.trim(), text }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        reply?: string;
        error?: string;
      };
      if (!res.ok) {
        setMsgs((m) => [
          ...m,
          { role: "assistant", text: `Error: ${data.error ?? res.status}` },
        ]);
      } else {
        setMsgs((m) => [...m, { role: "assistant", text: data.reply ?? "" }]);
      }
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      setMsgs((m) => [...m, { role: "assistant", text: `Error: ${err}` }]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed bottom-4 right-4 z-40">
      {open ? (
        <div className="w-80 h-[28rem] card flex flex-col shadow-lg">
          <div className="flex items-center justify-between px-3 py-2 border-b border-slate-200">
            <div className="text-sm font-medium">Chat con Toño</div>
            <button
              onClick={() => setOpen(false)}
              className="text-slate-500 hover:text-slate-900 text-sm"
            >
              ✕
            </button>
          </div>
          <div className="px-3 py-2 border-b border-slate-100 text-xs">
            <input
              type="tel"
              placeholder="Tu celular (+57…)"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              className="w-full border border-slate-300 rounded-md px-2 py-1 text-xs"
            />
          </div>
          <div
            ref={scrollRef}
            className="flex-1 overflow-y-auto px-3 py-2 space-y-2 text-sm"
          >
            {msgs.length === 0 && (
              <div className="text-slate-500 text-xs">
                Escribe "hola" para empezar. Toño responde con las mismas herramientas que en WhatsApp.
              </div>
            )}
            {msgs.map((m, i) => (
              <div
                key={i}
                className={`max-w-[85%] ${m.role === "user" ? "ml-auto bg-amber-50 border border-amber-200" : "mr-auto bg-slate-100"} rounded-md px-2 py-1`}
              >
                {m.text}
              </div>
            ))}
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              send();
            }}
            className="border-t border-slate-200 p-2 flex gap-1"
          >
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Escribe…"
              className="flex-1 border border-slate-300 rounded-md px-2 py-1 text-sm"
              disabled={busy}
            />
            <button
              type="submit"
              disabled={busy || !input.trim() || !phone.trim()}
              className="bg-amber-500 hover:bg-amber-600 disabled:opacity-60 text-white text-sm rounded-md px-3 py-1"
            >
              {busy ? "…" : "Enviar"}
            </button>
          </form>
        </div>
      ) : (
        <button
          onClick={() => setOpen(true)}
          className="bg-slate-900 hover:bg-slate-800 text-white rounded-full px-4 py-2 text-sm shadow-lg"
        >
          Chat con Toño
        </button>
      )}
    </div>
  );
}
