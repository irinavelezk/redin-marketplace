// Técnico's own postulaciones. Auth-gated.
// In v1 we map auth.user.email → tecnicos_extended by looking up a registration event
// meta that captured the email (future). Today we expect phone-based identification,
// which requires Twilio OTP (TODO). For v1, if the user email matches no técnico,
// we show a helpful onboarding CTA.

import { serverClientBoundToCookies, serviceClient } from "@/lib/supabase-server";
import { buildWaLink } from "@/lib/wa-link";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function MisAplicaciones() {
  const auth = serverClientBoundToCookies();
  const { data: userData } = await auth.auth.getUser();
  if (!userData.user) redirect("/login");

  // Best-effort tecnico lookup. Future: link Supabase auth users to tecnicos_extended
  // via an explicit `auth_user_id` column. For now, surface a hint.
  const supa = serviceClient();
  const { data: tecByEmail } = await supa
    .from("eventos")
    .select("entity_id")
    .eq("type", "tecnico_linked_to_auth")
    .eq("actor", `auth:${userData.user.email}`)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const tecnicoId = tecByEmail?.entity_id ?? null;

  if (!tecnicoId) {
    return (
      <div className="card p-4 space-y-3 max-w-xl">
        <h1 className="text-lg font-semibold text-slate-900">Mis aplicaciones</h1>
        <p className="text-sm text-slate-600">
          No encontramos tu perfil de técnico asociado a este correo todavía. La
          forma rápida: escríbele a Toño por WhatsApp y él te registra en segundos.
        </p>
        <a
          href={buildWaLink({ text: "Hola Toño, vengo del dashboard — necesito vincular mi cuenta." })}
          target="_blank"
          rel="noreferrer"
          className="inline-flex bg-amber-500 hover:bg-amber-600 text-white rounded-md px-3 py-1.5 text-sm font-medium"
        >
          Escribir a Toño
        </a>
      </div>
    );
  }

  const { data: postulaciones } = await supa
    .from("postulaciones")
    .select("*")
    .eq("tecnico_id", tecnicoId)
    .order("applied_at", { ascending: false });

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold text-slate-900">Mis aplicaciones</h1>
      {(postulaciones ?? []).length === 0 ? (
        <div className="card p-4 text-sm text-slate-600">
          Aún no has aplicado a ningún trabajo.
        </div>
      ) : (
        <ul className="space-y-2">
          {(postulaciones ?? []).map((p) => (
            <li key={p.id} className="card p-3 text-sm">
              <div className="font-medium text-slate-900">OT {p.ot_id}</div>
              <div className="text-slate-500">Estado: {p.state}</div>
              <div className="text-xs text-slate-400">
                Aplicaste {new Date(p.applied_at).toLocaleString("es-CO")}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
