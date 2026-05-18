// Cleanup utility for test técnicos.
// Usage: npx tsx --env-file=.env.local scripts/cleanup-tecnico.ts <cedula> <expected-name-substring> [--confirm]
//   <cedula> required, plain digits
//   <expected-name-substring> required, the safety check (case-insensitive); must MATCH the worker's nombre
//   --confirm  actually deletes; otherwise dry-run survey only
// Removes from Supabase (tecnicos_extended + cascades + sessions + events + turns + outbound)
// AND from AppSheet (Tecnicos sheet) when an appsheet_row_id is present.

import { createServerClient, requireEnv } from "@redin/shared";
import { AppSheetReadClient } from "../sync/src/appsheet";

const CEDULA = process.argv[2];
const EXPECTED_NAME = process.argv[3];
if (!CEDULA || !/^\d{5,12}$/.test(CEDULA)) {
  console.error(
    "ERROR: first arg must be cedula (5-12 digits). Got:",
    JSON.stringify(CEDULA)
  );
  process.exit(1);
}
if (!EXPECTED_NAME || EXPECTED_NAME.length < 3) {
  console.error(
    "ERROR: second arg must be expected-name-substring (≥3 chars) as safety check. Got:",
    JSON.stringify(EXPECTED_NAME)
  );
  process.exit(1);
}

async function main() {
  const supa = createServerClient();
  const confirm = process.argv.includes("--confirm");

  // 1. Find the tecnico, verify name match
  const { data: tec, error: tecErr } = await supa
    .from("tecnicos_extended")
    .select("tecnico_id, nombre, cedula, phone, contact_phone, candidate_state, appsheet_row_id")
    .eq("cedula", CEDULA)
    .maybeSingle();
  if (tecErr) {
    console.error("query failed:", tecErr.message);
    process.exit(1);
  }
  if (!tec) {
    console.log(`No tecnico_extended row for cedula=${CEDULA}. Maybe already cleaned.`);
  } else {
    const nombreLc = (tec.nombre ?? "").toLowerCase();
    if (!nombreLc.includes(EXPECTED_NAME.toLowerCase())) {
      console.error(
        `SAFETY ABORT: nombre is "${tec.nombre}", does not contain "${EXPECTED_NAME}".`
      );
      console.error("Refusing to delete a tecnico whose name doesn't match.");
      process.exit(1);
    }
    console.log("Target tecnico:", JSON.stringify(tec, null, 2));
  }

  const tecnicoId = tec?.tecnico_id;
  const phone = tec?.phone;
  const appsheetRowId = (tec as any)?.appsheet_row_id ?? null;
  const nombre = tec?.nombre ?? null;

  // 2. Survey what's about to be deleted (counts only)
  const surveys: Array<{ tbl: string; filter: string; count: number; err?: string }> = [];

  async function countBy(tbl: string, col: string, val: string) {
    const { count: c, error } = await (supa as any)
      .from(tbl)
      .select("*", { count: "exact", head: true })
      .eq(col, val);
    surveys.push({ tbl, filter: `${col}=${val.slice(0, 16)}…`, count: c ?? 0, err: error?.message });
  }

  if (tecnicoId) {
    await countBy("candidate_dossiers", "tecnico_id", tecnicoId);
    await countBy("candidate_decisions", "tecnico_id", tecnicoId);
    await countBy("postulaciones", "tecnico_id", tecnicoId);
    await countBy("ot_offers", "tecnico_id", tecnicoId);
    await countBy("documentos", "tecnico_id", tecnicoId);
    await countBy("hr_notes", "tecnico_id", tecnicoId);
    await countBy("tecnico_evaluations", "tecnico_id", tecnicoId);
    await countBy("turns", "tecnico_id", tecnicoId);
    await countBy("eventos", "entity_id", tecnicoId);
  }
  if (phone) {
    await countBy("sessions", "phone", phone);
    await countBy("outbound_messages", "phone", phone);
  }

  // Also check tecnicos_mirror (AppSheet read-only mirror)
  const { count: mirrorCount } = await supa
    .from("tecnicos_mirror")
    .select("*", { count: "exact", head: true })
    .ilike("data->>Cedula", `%${CEDULA}%`);
  surveys.push({ tbl: "tecnicos_mirror", filter: `data.Cedula~=${CEDULA}`, count: mirrorCount ?? 0 });

  console.log("\n=== SURVEY ===");
  for (const s of surveys) {
    const tag = s.err ? "❌" : s.count === 0 ? "  " : "🗑";
    console.log(`  ${tag} ${s.tbl.padEnd(22)} ${String(s.count).padStart(3)} rows  (${s.filter}${s.err ? ` ERR:${s.err}` : ""})`);
  }

  if (!confirm) {
    console.log("\nDry run. Pass --confirm to actually delete.");
    return;
  }

  if (!tecnicoId && !phone) {
    console.log("Nothing to delete.");
    return;
  }

  console.log("\n=== DELETING ===");

  // Delete in dependency-safe order. FK cascades handle most child tables;
  // we explicitly delete the ones without FK (eventos, sessions, outbound_messages).
  if (phone) {
    const out1 = await supa.from("outbound_messages").delete().eq("phone", phone);
    console.log(`  outbound_messages phone=${phone}: ${out1.error ? "ERR " + out1.error.message : "ok"}`);

    // Sessions cascades to messages (FK ON DELETE CASCADE assumed); delete it.
    const out2 = await supa.from("sessions").delete().eq("phone", phone);
    console.log(`  sessions phone=${phone}: ${out2.error ? "ERR " + out2.error.message : "ok"}`);
  }

  if (tecnicoId) {
    // turns has no FK to tecnico
    const out3 = await supa.from("turns").delete().eq("tecnico_id", tecnicoId);
    console.log(`  turns tecnico_id: ${out3.error ? "ERR " + out3.error.message : "ok"}`);

    // eventos has no FK on entity_id — clean by entity_id matching tecnico_id
    const out4 = await supa.from("eventos").delete().eq("entity_id", tecnicoId);
    console.log(`  eventos entity_id=tecnico_id: ${out4.error ? "ERR " + out4.error.message : "ok"}`);

    // Now nuke the tecnico — cascades to dossiers, decisions, postulaciones,
    // documentos, hr_notes, evaluations, ot_offers.
    const out5 = await supa.from("tecnicos_extended").delete().eq("tecnico_id", tecnicoId);
    console.log(`  tecnicos_extended (cascade): ${out5.error ? "ERR " + out5.error.message : "ok"}`);
  }

  // ---- AppSheet cleanup ----
  // The projector wrote Santiago into AppSheet at approve time. If we don't
  // remove him from AppSheet, the next AppSheet→Supabase mirror sync will
  // re-create a tecnicos_mirror row, and find_by_cedula priority-3 will route
  // the next screening through legacy enrichment instead of fresh.
  if (appsheetRowId && nombre) {
    console.log(`\n=== APPSHEET DELETE ===`);
    try {
      const appsheet = new AppSheetReadClient({
        appId: requireEnv("APPSHEET_APP_ID"),
        accessKey: requireEnv("APPSHEET_ACCESS_KEY"),
      });
      const result = await appsheet.deleteTecnico(appsheetRowId, nombre);
      console.log(`  AppSheet Tecnicos row_id=${appsheetRowId}: ${result.alreadyGone ? "alreadyGone (no-op)" : "deleted"}`);
    } catch (e: any) {
      console.log(`  ❌ AppSheet delete failed: ${e.message}`);
      console.log(`     Manual cleanup needed in AppSheet for Row ID ${appsheetRowId}.`);
    }
  } else {
    console.log(`\n(No appsheet_row_id on Supabase row — skipping AppSheet delete.)`);
  }

  if ((mirrorCount ?? 0) > 0) {
    console.log(`\n⚠️  tecnicos_mirror still has ${mirrorCount} row(s) for cedula ${CEDULA}.`);
    console.log(`   The mirror refreshes from AppSheet on next sync (cron every ~5min).`);
    console.log(`   If AppSheet delete above succeeded, the mirror will clear automatically.`);
  }

  console.log("\nDone.");
}

main().catch((e) => {
  console.error("fatal:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
