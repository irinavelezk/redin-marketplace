// Smoke test for v1 matching + offer flow readiness.
// Read-only — does NOT send WhatsApp, does NOT insert offers.
//
// What it does:
//   1. Counts approved+activo técnicos in the pool
//   2. Finds state-4 OTs (the only ones eligible for offers)
//   3. For each state-4 OT, reports: ciudad, has-alcance-pdf?, top-5 ranked técnicos
//   4. Surfaces the 1-2 OTs best suited for a real end-to-end manual test
//      (those with alcance_pdf_path + at least one approved técnico in same ciudad)
//   5. Verifies the new ot_offers table is queryable
//
// Run: npm run smoke:matching

import { createLogger, createServerClient, rankTecnicosForOT } from "@redin/shared";

const log = createLogger("smoke-matching");

const OFFERABLE_ESTADO = "4. Coordinar – Listo para ejecutar";

async function main() {
  const supabase = createServerClient();
  log.info("smoke-matching start");

  // ---------------------------------------------------------------------------
  // 1. Approved técnico pool snapshot
  // ---------------------------------------------------------------------------
  const { count: approvedCount, error: countErr } = await supabase
    .from("tecnicos_extended")
    .select("*", { count: "exact", head: true })
    .eq("candidate_state", "approved")
    .eq("estado", "activo");
  if (countErr) {
    log.error("approved count failed", { error: countErr.message });
    process.exit(1);
  }
  console.log(`\n=== POOL ===`);
  console.log(`Approved+activo técnicos: ${approvedCount ?? 0}`);

  if ((approvedCount ?? 0) === 0) {
    console.log(
      `\n⚠️  NO APPROVED TÉCNICOS. Smoke can run, but rankings will be empty.`
    );
  }

  // Sample 5 approved técnicos with their callable info
  const { data: sample } = await supabase
    .from("tecnicos_extended")
    .select("tecnico_id, nombre, phone, contact_phone")
    .eq("candidate_state", "approved")
    .eq("estado", "activo")
    .limit(5);
  if (sample && sample.length > 0) {
    console.log(`\nSample approved (first 5):`);
    for (const t of sample) {
      const phoneInfo = t.contact_phone
        ? `contact_phone=${t.contact_phone}`
        : `phone=${t.phone ?? "NULL"}`;
      console.log(
        `  - ${t.nombre ?? "<no name>"} | tecnico_id=${t.tecnico_id.slice(0, 12)}… | ${phoneInfo}`
      );
    }
  }

  // ---------------------------------------------------------------------------
  // 2. State-4 OTs in the system
  // ---------------------------------------------------------------------------
  const { data: state4Ots, error: otsErr } = await supabase
    .from("ots_mirror")
    .select("row_id, ciudad, especialidad, estado")
    .eq("estado", OFFERABLE_ESTADO)
    .limit(20);
  if (otsErr) {
    log.error("state4 query failed", { error: otsErr.message });
    process.exit(1);
  }

  console.log(`\n=== STATE-4 OTs ===`);
  console.log(`Found ${state4Ots?.length ?? 0} OTs in state "${OFFERABLE_ESTADO}"`);
  if (!state4Ots || state4Ots.length === 0) {
    console.log(`\n⚠️  NO STATE-4 OTs. Cannot send any offers until an architect`);
    console.log(`   produces alcance for a state-4 OT (or an existing OT advances).`);
    return;
  }

  // ---------------------------------------------------------------------------
  // 3. Check which state-4 OTs have alcance_pdf_path
  // ---------------------------------------------------------------------------
  const otIds = state4Ots.map((o) => o.row_id);
  const { data: extended } = await supabase
    .from("ots_extended")
    .select("ot_row_id, alcance_pdf_path, photo_paths, alcance_jsonb")
    .in("ot_row_id", otIds);
  const extByRow = new Map(extended?.map((e) => [e.ot_row_id, e]) ?? []);

  // ---------------------------------------------------------------------------
  // 4. For each state-4 OT, run rankTecnicosForOT and report
  // ---------------------------------------------------------------------------
  const readyForTest: Array<{
    ot_row_id: string;
    ciudad: string | null;
    has_pdf: boolean;
    photo_count: number;
    top_match: { nombre: string; ciudad: string | null; score_fit: number } | null;
  }> = [];

  for (const ot of state4Ots.slice(0, 5)) {
    const ext = extByRow.get(ot.row_id);
    const hasPdf = !!ext?.alcance_pdf_path;
    const photoCount = ext?.photo_paths?.length ?? 0;

    console.log(`\n--- OT ${ot.row_id.slice(0, 12)}… ---`);
    console.log(`  ciudad: ${ot.ciudad ?? "<null>"}`);
    console.log(`  especialidad (mirror): ${ot.especialidad ?? "<null>"}`);
    console.log(`  has_alcance_pdf: ${hasPdf ? "YES" : "NO"} | photos: ${photoCount}`);

    const result = await rankTecnicosForOT(supabase, ot.row_id, { limit: 5 });
    console.log(
      `  ot_especialidad resolved: "${result.ot_especialidad ?? "<null>"}" (source: ${result.alcance_source})`
    );
    console.log(`  total_approved pool: ${result.total_approved}`);
    console.log(`  ranked: ${result.ranked.length}`);
    for (const r of result.ranked) {
      console.log(
        `    • ${r.nombre || "<no name>"} (${r.ciudad ?? "?"}) — fit=${r.score_fit.toFixed(2)} prox=${r.score_proximidad.toFixed(2)} calidad=${r.score_calidad?.toFixed(1) ?? "—"}`
      );
      for (const reason of r.reasons) console.log(`        · ${reason}`);
    }

    if (hasPdf && result.ranked.length > 0) {
      readyForTest.push({
        ot_row_id: ot.row_id,
        ciudad: ot.ciudad,
        has_pdf: true,
        photo_count: photoCount,
        top_match: result.ranked[0]
          ? {
              nombre: result.ranked[0].nombre,
              ciudad: result.ranked[0].ciudad,
              score_fit: result.ranked[0].score_fit,
            }
          : null,
      });
    }
  }

  // ---------------------------------------------------------------------------
  // 5. Verify ot_offers table is queryable
  // ---------------------------------------------------------------------------
  console.log(`\n=== ot_offers TABLE CHECK ===`);
  const { count: offerCount, error: offerErr } = await supabase
    .from("ot_offers")
    .select("*", { count: "exact", head: true });
  if (offerErr) {
    console.log(`  ❌ ot_offers NOT queryable: ${offerErr.message}`);
    process.exit(1);
  }
  console.log(`  ✅ ot_offers queryable. Current rows: ${offerCount ?? 0}`);

  // ---------------------------------------------------------------------------
  // 6. Test recommendation
  // ---------------------------------------------------------------------------
  console.log(`\n=== READINESS REPORT ===`);
  if (readyForTest.length === 0) {
    console.log(`⚠️  NO OT is ready for an end-to-end offer test.`);
    console.log(`   To unblock: an architect must use Manos to capture scope`);
    console.log(`   (text + 1+ photo + ≥30 char summary) on a state-4 OT, then`);
    console.log(`   call finalize_alcance to generate the PDF.`);
  } else {
    console.log(`✅ ${readyForTest.length} OT(s) ready for manual offer test:`);
    for (const r of readyForTest) {
      console.log(
        `   - OT ${r.ot_row_id.slice(0, 12)}… in ${r.ciudad ?? "?"} (${r.photo_count} photos)`
      );
      if (r.top_match) {
        console.log(
          `     Top match: ${r.top_match.nombre} (${r.top_match.ciudad ?? "?"}) fit=${r.top_match.score_fit.toFixed(2)}`
        );
      }
    }
    console.log(`\n   Next step: open /hr/shortlist/<ot_row_id> in the dashboard,`);
    console.log(`   confirm the empty-state ranked list shows, click "Enviar oferta".`);
  }

  log.info("smoke-matching done");
}

main().catch((e) => {
  log.error("fatal", { error: e instanceof Error ? e.message : String(e) });
  process.exit(1);
});
