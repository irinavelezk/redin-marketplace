// Técnico contracts — same auth caveat as /me/aplicaciones.

import { serverClientBoundToCookies, serviceClient } from "@/lib/supabase-server";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function MisContratos() {
  const auth = serverClientBoundToCookies();
  const { data: userData } = await auth.auth.getUser();
  if (!userData.user) redirect("/login");

  const supa = serviceClient();
  const { data: link } = await supa
    .from("eventos")
    .select("entity_id")
    .eq("type", "tecnico_linked_to_auth")
    .eq("actor", `auth:${userData.user.email}`)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const tecnicoId = link?.entity_id ?? null;
  if (!tecnicoId) {
    return <div className="card p-4 text-sm">Vincula tu cuenta con Toño primero.</div>;
  }
  const { data: contratos } = await supa
    .from("contratos")
    .select("*")
    .eq("tecnico_id", tecnicoId)
    .order("sent_at", { ascending: false, nullsFirst: false });

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold text-slate-900">Mis contratos</h1>
      {(contratos ?? []).length === 0 ? (
        <div className="card p-4 text-sm text-slate-600">Sin contratos aún.</div>
      ) : (
        <ul className="space-y-2">
          {(contratos ?? []).map((c) => (
            <li key={c.id} className="card p-3 text-sm">
              <div className="font-medium text-slate-900">
                Contrato {c.id.slice(0, 8)}
              </div>
              <div className="text-slate-500">Estado: {c.status}</div>
              <div className="text-xs text-slate-400">OT {c.ot_id ?? "—"}</div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
