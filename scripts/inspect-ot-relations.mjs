import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } });

console.log("=== JOSE (cedula 88034262) ===");
const { data: arqs } = await sb.from("arquitectos_mirror").select("row_id, data");
const jose = arqs.find((a) => String(a.data?.Cedula ?? "").replace(/\D/g, "") === "88034262");
console.log("Jose row_id:", jose?.row_id);
console.log();

console.log("=== all state-4 OTs — ID_Arquitecto + Nombre_Arquitecto_Real + Alcance_OT ===");
const { data: ots } = await sb.from("ots_mirror").select("row_id, ciudad, data").eq("estado", "4. Coordinar – Listo para ejecutar");
for (const ot of ots) {
  const d = ot.data ?? {};
  console.log({
    row_id: ot.row_id,
    _RowNumber: d._RowNumber,
    ciudad: ot.ciudad,
    ID_Arquitecto: d.ID_Arquitecto,
    Nombre_Arquitecto_Real: d.Nombre_Arquitecto_Real,
    Arquitecto_Asignado: d.Arquitecto_Asignado ?? "(none)",
    Alcance_OT: d.Alcance_OT ?? "(empty)",
    descripcion: String(d.Descripcion ?? "").slice(0, 60),
    is_jose: d.ID_Arquitecto === jose?.row_id,
  });
}
console.log(`\ntotal state-4 OTs: ${ots.length}`);
console.log(`Jose's state-4 OTs (by ID_Arquitecto): ${ots.filter((o) => o.data?.ID_Arquitecto === jose?.row_id).length}`);
