// HR contracts index — list every contract with status filter and
// worker-name/cédula search. Friction #4: HR had no way to find a contract
// without going through pipeline → shortlist → contract per worker.
//
// Columns: Estado · Trabajador (nombre · ciudad) · OT (descripción) · Enviado · Firmado
// Filters: status chips with counts (Todos / Borrador / Enviado / Firmado / Cancelado)
// Search: substring match on nombre OR cédula (case-insensitive, server-side)
// Sort:   coalesce(signed_at, sent_at, created_at) DESC — latest activity first

import { serverClientBoundToCookies, serviceClient } from "@/lib/supabase-server";
import { otTitle, tecnicoLabel } from "@/lib/ot-display";
import type { ContratoRow, ContratoStatus } from "@redin/shared";
import { redirect } from "next/navigation";
import Link from "next/link";

export const dynamic = "force-dynamic";

const STATUS_CHIPS: { label: string; value: ContratoStatus | undefined }[] = [
  { label: "Todos", value: undefined },
  { label: "Borrador", value: "borrador" },
  { label: "Enviado", value: "enviado" },
  { label: "Firmado", value: "firmado" },
  { label: "Cancelado", value: "cancelado" },
];

const STATUS_CLASS: Record<string, string> = {
  borrador: "bg-slate-100 text-slate-700",
  enviado: "bg-amber-100 text-amber-800",
  firmado: "bg-emerald-100 text-emerald-800",
  cancelado: "bg-rose-100 text-rose-800",
};

function fmt(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("es-CO", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function isContratoStatus(v: string | undefined): v is ContratoStatus {
  return v === "borrador" || v === "enviado" || v === "firmado" || v === "cancelado";
}

export default async function HrContratosIndexPage({
  searchParams,
}: {
  searchParams?: { status?: string; q?: string };
}) {
  const auth = serverClientBoundToCookies();
  const { data: userData } = await auth.auth.getUser();
  if (!userData.user) redirect("/login");

  const supa = serviceClient();
  const statusFilter = isContratoStatus(searchParams?.status)
    ? searchParams.status
    : undefined;
  const q = (searchParams?.q ?? "").trim();

  // Pull all contracts. At pilot scale (10s/month) this is fine; at >5k
  // contracts revisit with a Postgres view + cursor pagination.
  const { data: allContracts } = await supa
    .from("contratos")
    .select("*")
    .order("signed_at", { ascending: false, nullsFirst: false })
    .order("sent_at", { ascending: false, nullsFirst: false });

  const contracts: ContratoRow[] = allContracts ?? [];

  // Status counts for the chip badges — count from the unfiltered set so
  // each chip shows its true total regardless of which one is active.
  const counts: Record<string, number> = {
    borrador: 0,
    enviado: 0,
    firmado: 0,
    cancelado: 0,
  };
  for (const c of contracts) counts[c.status] = (counts[c.status] ?? 0) + 1;

  // Hydrate worker labels (nombre, cédula, ciudad from event meta).
  const tecnicoIds = [...new Set(contracts.map((c) => c.tecnico_id))];
  const otIds = [
    ...new Set(contracts.map((c) => c.ot_id).filter((x): x is string => !!x)),
  ];

  const [tecsRes, ciudadEventsRes, otsRes] = await Promise.all([
    tecnicoIds.length
      ? supa
          .from("tecnicos_extended")
          .select("tecnico_id, nombre, cedula")
          .in("tecnico_id", tecnicoIds)
      : Promise.resolve({ data: [] }),
    tecnicoIds.length
      ? supa
          .from("eventos")
          .select("entity_id, meta, created_at")
          .eq("type", "tecnico_registered")
          .in("entity_id", tecnicoIds)
          .order("created_at", { ascending: false })
      : Promise.resolve({ data: [] }),
    otIds.length
      ? supa
          .from("ots_mirror")
          .select("row_id, ciudad, data")
          .in("row_id", otIds)
      : Promise.resolve({ data: [] }),
  ]);
  const nombreByTec = new Map<string, string | null>();
  const cedulaByTec = new Map<string, string | null>();
  for (const t of tecsRes.data ?? []) {
    nombreByTec.set(t.tecnico_id, t.nombre ?? null);
    cedulaByTec.set(t.tecnico_id, t.cedula ?? null);
  }
  const ciudadByTec = new Map<string, string | null>();
  for (const e of ciudadEventsRes.data ?? []) {
    if (!e.entity_id || ciudadByTec.has(e.entity_id)) continue;
    const meta = e.meta as Record<string, unknown> | null;
    const c = meta && typeof meta.ciudad === "string" ? meta.ciudad : null;
    ciudadByTec.set(e.entity_id, c);
  }
  const otTitleByRowId = new Map<string, string>();
  for (const o of otsRes.data ?? []) {
    otTitleByRowId.set(o.row_id, otTitle(o));
  }

  // Apply filters in memory — search hits nombre OR cédula. Status filter
  // applied on top.
  const qLower = q.toLowerCase();
  const filtered = contracts.filter((c) => {
    if (statusFilter && c.status !== statusFilter) return false;
    if (q) {
      const nombre = (nombreByTec.get(c.tecnico_id) ?? "").toLowerCase();
      const cedula = (cedulaByTec.get(c.tecnico_id) ?? "").toLowerCase();
      if (!nombre.includes(qLower) && !cedula.includes(qLower)) return false;
    }
    return true;
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-slate-900">Contratos</h1>
        <div className="flex items-center gap-3">
          <Link
            href="/hr/pipeline"
            className="text-sm text-slate-600 hover:text-slate-900"
          >
            Pipeline →
          </Link>
          <Link
            href="/hr/tecnicos"
            className="text-sm text-slate-500 hover:text-slate-700"
          >
            Técnicos →
          </Link>
        </div>
      </div>

      <div className="flex flex-wrap gap-2 items-center text-sm">
        {STATUS_CHIPS.map((c) => {
          const active = (c.value ?? "") === (statusFilter ?? "");
          const params = new URLSearchParams();
          if (c.value) params.set("status", c.value);
          if (q) params.set("q", q);
          const href = params.size ? `/hr/contratos?${params.toString()}` : "/hr/contratos";
          const count = c.value ? counts[c.value] ?? 0 : contracts.length;
          return (
            <Link
              key={c.label}
              href={href}
              className={
                active
                  ? "bg-slate-900 text-white rounded-full px-3 py-1"
                  : "bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-full px-3 py-1"
              }
            >
              {c.label}{" "}
              <span
                className={
                  active ? "tabular-nums text-slate-300" : "tabular-nums text-slate-500"
                }
              >
                {count}
              </span>
            </Link>
          );
        })}
        <form action="/hr/contratos" className="flex items-center gap-2 ml-auto">
          {statusFilter && <input type="hidden" name="status" value={statusFilter} />}
          <input
            type="search"
            name="q"
            defaultValue={q}
            placeholder="Buscar por nombre o cédula"
            className="border border-slate-200 rounded px-3 py-1 text-sm w-64"
          />
          {q && (
            <Link
              href={statusFilter ? `/hr/contratos?status=${statusFilter}` : "/hr/contratos"}
              className="text-xs text-slate-500 hover:text-slate-700"
            >
              limpiar
            </Link>
          )}
        </form>
      </div>

      {filtered.length === 0 ? (
        <div className="card p-4 text-sm text-slate-500">
          {q || statusFilter
            ? "Ningún contrato coincide con el filtro."
            : "Aún no hay contratos."}
        </div>
      ) : (
        <div className="overflow-x-auto card">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-600 text-xs uppercase tracking-wide">
              <tr>
                <th className="text-left px-3 py-2">Estado</th>
                <th className="text-left px-3 py-2">Trabajador</th>
                <th className="text-left px-3 py-2">Trabajo</th>
                <th className="text-left px-3 py-2">Enviado</th>
                <th className="text-left px-3 py-2">Firmado</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((c) => {
                const statusClass =
                  STATUS_CLASS[c.status] ?? "bg-slate-100 text-slate-700";
                const tecLabel = tecnicoLabel({
                  nombre: nombreByTec.get(c.tecnico_id) ?? null,
                  ciudad: ciudadByTec.get(c.tecnico_id) ?? null,
                });
                const otLabel = c.ot_id
                  ? otTitleByRowId.get(c.ot_id) ?? "Trabajo sin título"
                  : "—";
                return (
                  <tr
                    key={c.id}
                    className="border-t border-slate-100 hover:bg-slate-50"
                  >
                    <td className="px-3 py-2">
                      <span
                        className={`inline-block rounded-full px-2 py-0.5 text-xs ${statusClass}`}
                      >
                        {c.status}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      <Link
                        href={`/hr/contratos/${c.id}`}
                        className="text-slate-900 hover:text-amber-700 font-medium"
                      >
                        {tecLabel}
                      </Link>
                      {cedulaByTec.get(c.tecnico_id) && (
                        <div className="text-[11px] text-slate-400 font-mono">
                          cc {cedulaByTec.get(c.tecnico_id)}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2 text-slate-700 max-w-md truncate">
                      {otLabel}
                    </td>
                    <td className="px-3 py-2 text-xs text-slate-500">
                      {c.sent_at ? fmt(c.sent_at) : "—"}
                    </td>
                    <td className="px-3 py-2 text-xs text-slate-500">
                      {c.signed_at ? fmt(c.signed_at) : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
