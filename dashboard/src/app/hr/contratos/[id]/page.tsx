// HR contract view — generate PDF, mark enviado, upload signed, mark firmado.
// Server actions + simple signed URL from Supabase Storage.

import { serverClientBoundToCookies, serviceClient } from "@/lib/supabase-server";
import { enqueueWhatsApp, tecnicoNotificationContext } from "@/lib/notify";
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

  const { data: contract } = await supa
    .from("contratos")
    .select("ot_id, tecnico_id")
    .eq("id", contractId)
    .maybeSingle();
  if (contract?.tecnico_id) {
    const { phone, descripcion } = await tecnicoNotificationContext(
      supa,
      contract.tecnico_id,
      contract.ot_id
    );
    if (phone) {
      const trabajo = descripcion ?? "el trabajo";
      await enqueueWhatsApp(supa, {
        phone,
        body: `Te llegó el contrato de "${trabajo}". Revísalo y firma cuando puedas — cualquier duda me dices.`,
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

  return (
    <div className="space-y-4 max-w-xl">
      <Link href="/hr/pipeline" className="text-sm text-slate-500 hover:text-slate-700">
        ← pipeline
      </Link>
      <div className="card p-4">
        <h1 className="font-semibold text-slate-900">Contrato {contract.id.slice(0, 8)}</h1>
        <div className="text-sm text-slate-600 mt-1">
          Técnico: {contract.tecnico_id} · OT: {contract.ot_id ?? "—"}
        </div>
        <div className="text-sm text-slate-600">
          Estado: <strong>{contract.status}</strong>
        </div>
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
              disabled={contract.status !== "borrador"}
              className="text-sm bg-amber-500 hover:bg-amber-600 disabled:opacity-50 text-white rounded-md px-3 py-1.5"
            >
              Marcar como enviado
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
