// HR contract detail page. Two actions, both in <ContractActions>:
//   "Generar y enviar"   → generates PDF, uploads, flips to enviado, sends WA
//   "Subir firmado"      → file picker + signed-URL upload, flips to firmado
// Old 5-button workflow + paste-storage-path textbox replaced per friction #3.

import { serverClientBoundToCookies, serviceClient } from "@/lib/supabase-server";
import { otTitle, tecnicoLabel } from "@/lib/ot-display";
import { redirect } from "next/navigation";
import Link from "next/link";
import { ContractActions } from "./ContractActions";

export const dynamic = "force-dynamic";

interface Props {
  params: { id: string };
}

const STATUS_CLASS: Record<string, string> = {
  borrador: "bg-slate-100 text-slate-700",
  enviado: "bg-amber-100 text-amber-800",
  firmado: "bg-emerald-100 text-emerald-800",
  cancelado: "bg-rose-100 text-rose-800",
};

function fmt(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("es-CO");
}

export default async function ContractPage({ params }: Props) {
  const auth = serverClientBoundToCookies();
  const { data: userData } = await auth.auth.getUser();
  if (!userData.user) redirect("/login");

  const supa = serviceClient();
  const { data: contract } = await supa
    .from("contratos")
    .select("*")
    .eq("id", params.id)
    .maybeSingle();
  if (!contract) return <div className="card p-4">Contrato no encontrado.</div>;

  // Pull human labels so the page never leads with a UUID. Worker nombre
  // comes from tecnicos_extended (post migration 010); ciudad from the
  // tecnico_registered event meta (same source identify_user uses); OT
  // title from ots_mirror.data via otTitle().
  const [tecRes, ciudadEventRes, otRes] = await Promise.all([
    supa
      .from("tecnicos_extended")
      .select("nombre")
      .eq("tecnico_id", contract.tecnico_id)
      .maybeSingle(),
    supa
      .from("eventos")
      .select("meta")
      .eq("type", "tecnico_registered")
      .eq("entity_id", contract.tecnico_id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    contract.ot_id
      ? supa
          .from("ots_mirror")
          .select("ciudad, data")
          .eq("row_id", contract.ot_id)
          .maybeSingle()
      : Promise.resolve({ data: null }),
  ]);
  const tecnicoNombre = tecRes.data?.nombre ?? null;
  const ciudadMeta = ciudadEventRes.data?.meta;
  const tecnicoCiudad =
    ciudadMeta && typeof ciudadMeta === "object" && !Array.isArray(ciudadMeta)
      ? (ciudadMeta as Record<string, unknown>).ciudad
      : null;
  const tecLabel = tecnicoLabel({
    nombre: tecnicoNombre,
    ciudad: typeof tecnicoCiudad === "string" ? tecnicoCiudad : null,
  });
  const otHeadline = otTitle(otRes.data);
  const statusClass = STATUS_CLASS[contract.status] ?? "bg-slate-100 text-slate-700";

  return (
    <div className="space-y-4 max-w-xl">
      <div className="flex items-center gap-3 text-sm text-slate-500">
        <Link href="/hr/contratos" className="hover:text-slate-700">
          ← contratos
        </Link>
        <Link href="/hr/pipeline" className="hover:text-slate-700">
          · pipeline
        </Link>
      </div>
      <div className="card p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-xs text-slate-500 uppercase tracking-wide">
              Contrato
            </div>
            <h1 className="font-semibold text-slate-900 mt-0.5">
              <Link
                href={`/hr/tecnicos/${encodeURIComponent(contract.tecnico_id)}`}
                className="hover:text-amber-700"
              >
                {tecLabel}
              </Link>
            </h1>
            <div className="text-sm text-slate-700 mt-1">{otHeadline}</div>
          </div>
          <span
            className={`inline-block rounded-full px-3 py-0.5 text-xs ${statusClass} shrink-0`}
          >
            {contract.status}
          </span>
        </div>
        <div className="text-xs text-slate-500 mt-2 flex flex-wrap gap-3">
          {contract.sent_at && <span>Enviado {fmt(contract.sent_at)}</span>}
          {contract.signed_at && <span>Firmado {fmt(contract.signed_at)}</span>}
          {contract.signed_pdf_storage_path && (
            <span className="font-mono text-[10px] text-slate-400">
              {contract.signed_pdf_storage_path}
            </span>
          )}
        </div>
        <div className="text-[11px] text-slate-400 font-mono mt-1">
          {contract.id.slice(0, 8)}
          {contract.ot_id && <> · OT {contract.ot_id.slice(0, 8)}</>}
        </div>

        <div className="mt-4 border-t border-slate-100 pt-4">
          <ContractActions contractId={contract.id} status={contract.status} />
        </div>
      </div>
    </div>
  );
}
