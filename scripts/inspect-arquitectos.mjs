// One-off: list architects + show raw vs normalized cédula.
import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SECRET_KEY;
if (!url || !key) {
  console.error("Missing SUPABASE_URL / SUPABASE_SECRET_KEY");
  process.exit(1);
}
const supabase = createClient(url, key, { auth: { persistSession: false } });

const { data, error } = await supabase
  .from("arquitectos_mirror")
  .select("row_id, data")
  .limit(20);

if (error) {
  console.error("error:", error.message);
  process.exit(1);
}

console.log(`total rows: ${data.length}\n`);
for (const r of data) {
  const d = r.data;
  const rawCed = d?.Cedula ?? null;
  const norm = String(rawCed ?? "").replace(/\D/g, "") || null;
  console.log(`  row_id=${r.row_id}`);
  console.log(`    Nombre: ${d?.Nombre ?? d?.["Nombre de Arquitecto"] ?? "?"}`);
  console.log(`    Cedula raw: ${rawCed}`);
  console.log(`    Cedula normalized: ${norm}`);
  console.log(`    Telefono: ${d?.Telefono ?? d?.WhatsApp ?? "?"}`);
  console.log("");
}
