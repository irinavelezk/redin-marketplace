// Document upload — técnico uploads to Supabase Storage (bucket: documentos)
// and we record a documentos row via the /api/documentos endpoint.

"use client";

import { useState } from "react";
import { browserClient } from "@/lib/supabase-browser";

const TIPOS = [
  { value: "cedula", label: "Cédula" },
  { value: "cert_electrica", label: "Cert. eléctrica" },
  { value: "arl", label: "ARL" },
  { value: "ss", label: "Seguridad social" },
  { value: "altura", label: "Trabajo en alturas" },
  { value: "antecedentes", label: "Antecedentes" },
  { value: "otro", label: "Otro" },
];

export default function DocumentosPage() {
  const [tipo, setTipo] = useState("cedula");
  const [file, setFile] = useState<File | null>(null);
  const [tecnicoId, setTecnicoId] = useState("");
  const [status, setStatus] = useState<"idle" | "uploading" | "ok" | "err">("idle");
  const [msg, setMsg] = useState("");

  async function upload() {
    if (!file || !tecnicoId) {
      setStatus("err");
      setMsg("Falta técnico id o archivo");
      return;
    }
    setStatus("uploading");
    setMsg("");
    const supa = browserClient();
    // Safe filename.
    const safe = file.name.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) || "file";
    const storagePath = `${tecnicoId}/${tipo}/${Date.now()}-${safe}`;
    const { error: upErr } = await supa.storage
      .from("documentos")
      .upload(storagePath, file, {
        contentType: file.type || "application/octet-stream",
        upsert: false,
      });
    if (upErr) {
      setStatus("err");
      setMsg(`Upload falló: ${upErr.message}`);
      return;
    }
    // Record via server endpoint so it runs under secret key + writes eventos.
    const res = await fetch("/api/documentos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tecnico_id: tecnicoId,
        tipo,
        filename: file.name,
        storage_path: storagePath,
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      setStatus("err");
      setMsg(`Registrar falló: ${text}`);
      return;
    }
    setStatus("ok");
    setMsg("Subido y registrado.");
    setFile(null);
  }

  return (
    <div className="space-y-4 max-w-lg">
      <h1 className="text-lg font-semibold text-slate-900">Subir documento</h1>
      <div className="card p-4 space-y-3">
        <label className="block text-sm">
          Tu técnico id (copia el que te dio Toño)
          <input
            className="mt-1 w-full border border-slate-300 rounded-md px-3 py-2 text-sm"
            value={tecnicoId}
            onChange={(e) => setTecnicoId(e.target.value)}
          />
        </label>
        <label className="block text-sm">
          Tipo
          <select
            value={tipo}
            onChange={(e) => setTipo(e.target.value)}
            className="mt-1 w-full border border-slate-300 rounded-md px-3 py-2 text-sm"
          >
            {TIPOS.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm">
          Archivo
          <input
            type="file"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="mt-1 block w-full text-sm"
          />
        </label>
        <button
          type="button"
          onClick={upload}
          disabled={status === "uploading"}
          className="bg-amber-500 hover:bg-amber-600 disabled:opacity-60 text-white rounded-md px-3 py-1.5 text-sm"
        >
          {status === "uploading" ? "Subiendo…" : "Subir"}
        </button>
        {msg && (
          <div className={`text-sm ${status === "err" ? "text-red-700" : "text-emerald-700"}`}>
            {msg}
          </div>
        )}
      </div>
    </div>
  );
}
