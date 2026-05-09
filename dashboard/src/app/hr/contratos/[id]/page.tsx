// HR contract view — generate PDF, mark enviado, upload signed, mark firmado.
// Server actions + simple signed URL from Supabase Storage.

import { serverClientBoundToCookies, serviceClient } from "@/lib/supabase-server";
import {
  enqueueWhatsApp,
  enqueueWhatsAppDocument,
  tecnicoNotificationContext,
} from "@/lib/notify";
import { otTitle, tecnicoLabel } from "@/lib/ot-display";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import Link from "next/link";

export const dynamic = "force-dynamic";

async function markSent(formData: FormData) {
  "use server";
  const auth = serverClientBoundToCookies();
  const { data: userData } = await auth.auth.getUser();
  if (!userData.user) redirect("/login");
  const hrEmail = userData.user.email ?? userData.user.id;

  const supa = serviceClient();
  const contractId = formData.get("contract_id");
  if (typeof contractId !== "string") return;

  // Fetch the contract first so we can decide whether to send the PDF as a
  // WhatsApp document. If the borrador hasn't been generated yet (HR didn't
  // click "Descargar borrador"), redirect with an error param so the page
  // shows a hint instead of silently sending a text-only notification.
  const { data: contract } = await supa
    .from("contratos")
    .select("ot_id, tecnico_id, pdf_storage_path")
    .eq("id", contractId)
    .maybeSingle();
  if (!contract) return;
  if (!contract.pdf_storage_path) {
    redirect(`/hr/contratos/${contractId}?error=no_pdf`);
  }

  const nowIso = new Date().toISOString();
  await supa
    .from("contratos")
    .update({ status: "enviado", sent_at: nowIso })
    .eq("id", contractId);
  await supa.from("eventos").insert({
    type: "contract_sent",
    entity_id: contractId,
    actor: `hr:${hrEmail}`,
    meta: {},
  });

  if (contract.tecnico_id) {
    const { phone, descripcion } = await tecnicoNotificationContext(
      supa,
      contract.tecnico_id,
      contract.ot_id
    );
    if (phone) {
      const trabajo = descripcion ?? "el trabajo";
      await enqueueWhatsAppDocument(supa, {
        phone,
        body: `Te llegó el contrato de "${trabajo}". Revísalo y firma cuando puedas — cualquier duda me dices.`,
        attachment_path: contract.pdf_storage_path,
        attachment_filename: `contrato-${contractId.slice(0, 8)}.pdf`,
        attachment_bucket: "contratos",
        meta: { kind: "contract_sent", contract_id: contractId },
      });
    }
  }

  revalidatePath(`/hr/contratos/${contractId}`);
}

async function markSigned(formData: FormData) {
  "use server";
  const auth = serverClientBoundToCookies();
  const { data: userData } = await auth.auth.getUser();
  if (!userData.user) redirect("/login");
  const hrEmail = userData.user.email ?? userData.user.id;

  const supa = serviceClient();
  const contractId = formData.get("contract_id");
  const signedPath = formData.get("signed_path");
  if (typeof contractId !== "string") return;
  const nowIso = new Date().toISOString();
  await supa
    .from("contratos")
    .update({
      status: "firmado",
      signed_at: nowIso,
      signed_pdf_storage_path:
        typeof signedPath === "string" && signedPath.trim() ? signedPath.trim() : null,
    })
    .eq("id", contractId);

  const { data: contract } = await supa
    .from("contratos")
    .select("ot_id, tecnico_id")
    .eq("id", contractId)
    .maybeSingle();
  await supa.from("eventos").insert({
    type: "contract_signed",
    entity_id: contractId,
    actor: `hr:${hrEmail}`,
    meta: {
      ot_id: contract?.ot_id ?? null,
      tecnico_id: contract?.tecnico_id ?? null,
    },
  });

  // Flip the postulación to 'asignado' so the técnico sees it.
  if (contract?.ot_id && contract?.tecnico_id) {
    await supa
      .from("postulaciones")
      .update({
        state: "asignado",
        decided_at: nowIso,
        decided_by: `hr:${hrEmail}`,
      })
      .eq("ot_id", contract.ot_id)
      .eq("tecnico_id", contract.tecnico_id);

    const { phone, descripcion } = await tecnicoNotificationContext(
      supa,
      contract.tecnico_id,
      contract.ot_id
    );
    if (phone) {
      const trabajo = descripcion ?? "el trabajo";
      await enqueueWhatsApp(supa, {
        phone,
        body: `Listo — quedaste asignado a "${trabajo}". ¡Manos a la obra! Cualquier cosa me dices.`,
        meta: { kind: "asignado", contract_id: contractId, ot_id: contract.ot_id },
      });
    }
  }

  revalidatePath(`/hr/contratos/${contractId}`);
}

interface Props {
  params: { id: string };
  searchParams?: { error?: string };
}

export default async function ContractPage({ params, searchParams }: Props) {
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

  const noPdfYet = !contract.pdf_storage_path;
  const showNoPdfError = searchParams?.error === "no_pdf";

  return (
    <div className="space-y-4 max-w-xl">
      <Link href="/hr/pipeline" className="text-sm text-slate-500 hover:text-slate-700">
        ← pipeline
      </Link>
      <div className="card p-4">
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
        <div className="text-sm text-slate-600 mt-1">
          Estado: <strong>{contract.status}</strong>
        </div>
        <div className="text-[11px] text-slate-400 font-mono mt-1">
          {contract.id.slice(0, 8)}
          {contract.ot_id && <> · OT {contract.ot_id.slice(0, 8)}</>}
        </div>
        {showNoPdfError && (
          <div className="mt-3 rounded-md bg-amber-50 border border-amber-200 px-3 py-2 text-sm text-amber-900">
            Tienes que descargar el borrador primero (eso genera el PDF y lo
            sube a Storage) — luego puedes enviarlo por WhatsApp.
          </div>
        )}
        <div className="mt-3 flex flex-wrap gap-2">
          <a
            href={`/api/contract/${contract.id}/draft`}
            target="_blank"
            rel="noreferrer"
            className="text-sm bg-slate-900 hover:bg-slate-800 text-white rounded-md px-3 py-1.5"
          >
            Descargar borrador (PDF)
          </a>
          <form action={markSent}>
            <input type="hidden" name="contract_id" value={contract.id} />
            <button
              type="submit"
              disabled={contract.status !== "borrador" || noPdfYet}
              title={
                noPdfYet
                  ? "Descarga el borrador primero para generar el PDF"
                  : undefined
              }
              className="text-sm bg-amber-500 hover:bg-amber-600 disabled:opacity-50 text-white rounded-md px-3 py-1.5"
            >
              {contract.status === "borrador"
                ? "Enviar contrato por WhatsApp"
                : "Marcar como enviado"}
            </button>
          </form>
        </div>
        <form action={markSigned} className="mt-4 space-y-2 border-t border-slate-100 pt-4">
          <div className="text-sm text-slate-700">
            Después de firmado offline, sube la ruta del PDF firmado (en el bucket
            <code className="mx-1 bg-slate-100 px-1 rounded">contratos</code>)
            y marca como firmado.
          </div>
          <input type="hidden" name="contract_id" value={contract.id} />
          <input
            type="text"
            name="signed_path"
            placeholder={`${contract.id}/signed.pdf`}
            className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm"
          />
          <button
            type="submit"
            disabled={contract.status === "firmado"}
            className="text-sm bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white rounded-md px-3 py-1.5"
          >
            Marcar como firmado
          </button>
        </form>
      </div>
    </div>
  );
}
