// Phase 0 smoke test — seeds test data, exercises all 9 tools, drives the
// postulación → preseleccionado → contrato transition, then cleans up.
// PASS/FAIL report to stdout; exit 0 on pass, 1 on any failure.
//
// Runs against the REAL Supabase project (no mocks). Isolated by a unique
// run-id prefix on all test records so real data is never touched.

import { randomUUID } from "node:crypto";
import {
  createLogger,
  createServerClient,
  type ServerClient,
} from "@redin/shared";
import {
  createPostulacion,
  escalateToHr,
  identifyUser,
  logEvent,
  LoggingEscalationSink,
  makeDefaultToolContext,
  readMyContratos,
  readMyPostulaciones,
  readPendingOts,
  registerTecnico,
  uploadDocumento,
  type ToolContext,
  type ToolResult,
} from "@redin/tools";

const log = createLogger("smoke");

interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}

const RUN_ID = `smoke-${Date.now()}-${randomUUID().slice(0, 6)}`;
const PHONE_A = `+5790000${String(Date.now()).slice(-5)}`;
const PHONE_B = `+5790001${String(Date.now()).slice(-5)}`;
// Migration 011: contact_phone is required by validateIdentity in
// register-tecnico. Smoke uses callable-shaped 10-digit numbers (distinct
// from the WhatsApp identity in PHONE_A/B) so the happy path passes.
const CONTACT_A = `300${String(Date.now()).slice(-7)}`;
const CONTACT_B = `301${String(Date.now()).slice(-7)}`;
const TEST_OT_ID = `${RUN_ID}-ot`;

async function main() {
  const checks: Check[] = [];
  const supabase: ServerClient = createServerClient();
  const ctx: ToolContext = makeDefaultToolContext({
    supabase,
    defaultActor: "system",
    escalationSink: new LoggingEscalationSink(log),
  });

  log.info("smoke start", { run_id: RUN_ID });

  try {
    // 0. Seed a fake OT in ots_mirror so tools can resolve it.
    // read_pending_ots only surfaces OTs in state '4. Coordinar – Listo para
    // ejecutar' (commit c4e67a8 / 'show only state-4 OTs') — seed the smoke
    // OT in that state so the read-side check finds it.
    {
      const offerable = "4. Coordinar – Listo para ejecutar";
      const { error } = await supabase.from("ots_mirror").insert({
        row_id: TEST_OT_ID,
        data: {
          "Row ID": TEST_OT_ID,
          Descripcion: `SMOKE TEST — ${RUN_ID} — ignore`,
          Ciudad: "Cali",
          Categoria: "Eléctrico",
          Estado: offerable,
        },
        ciudad: "Cali",
        especialidad: "Eléctrico",
        estado: offerable,
      });
      checks.push({ name: "seed OT mirror", ok: !error, detail: error?.message });
      if (error) throw new Error(`seed failed: ${error.message}`);
    }

    // 1. identify_user — phone that does not exist yet → found:false
    {
      const r = await identifyUser(ctx, { phone: PHONE_A });
      const ok = r.ok && r.data.found === false;
      checks.push({
        name: "identify_user (not found)",
        ok,
        detail: ok ? undefined : JSON.stringify(r),
      });
    }

    // 2a. register_tecnico identity gate — single-token nombre rejected.
    // Phase 0a: validateIdentity refuses a partial-identity row and tells the
    // agent what to ask next via next_action / missing / user_message_hint.
    {
      const r = await registerTecnico(ctx, {
        phone: PHONE_A,
        nombre: "Manuel",
        ciudad: "Cali",
        especialidades: ["Eléctrico"],
        modalidad: "individual",
        contact_phone: CONTACT_A,
        source: "smoke",
      });
      const ok =
        !r.ok &&
        r.error === "INCOMPLETE_IDENTITY" &&
        r.next_action === "ask_apellidos" &&
        Array.isArray(r.missing) &&
        r.missing.includes("apellidos") &&
        typeof r.user_message_hint === "string" &&
        r.user_message_hint.length > 0;
      checks.push({
        name: "register_tecnico A (single-token nombre rejected)",
        ok,
        detail: ok ? undefined : JSON.stringify(r),
      });
    }

    // 2b. register_tecnico identity gate — missing contact_phone rejected.
    {
      const r = await registerTecnico(ctx, {
        phone: PHONE_A,
        nombre: "Manuel Pérez García",
        ciudad: "Cali",
        especialidades: ["Eléctrico"],
        modalidad: "individual",
        // contact_phone intentionally omitted
        source: "smoke",
      });
      const ok =
        !r.ok &&
        r.error === "INCOMPLETE_IDENTITY" &&
        r.next_action === "ask_contact_phone" &&
        Array.isArray(r.missing) &&
        r.missing.includes("contact_phone") &&
        typeof r.user_message_hint === "string";
      checks.push({
        name: "register_tecnico A (missing contact_phone rejected)",
        ok,
        detail: ok ? undefined : JSON.stringify(r),
      });
    }

    // 2c. register_tecnico identity gate — malformed contact_phone rejected.
    {
      const r = await registerTecnico(ctx, {
        phone: PHONE_A,
        nombre: "Manuel Pérez García",
        ciudad: "Cali",
        especialidades: ["Eléctrico"],
        modalidad: "individual",
        contact_phone: "no-es-un-teléfono",
        source: "smoke",
      });
      const ok =
        !r.ok &&
        r.error === "INCOMPLETE_IDENTITY" &&
        r.next_action === "ask_contact_phone";
      checks.push({
        name: "register_tecnico A (malformed contact_phone rejected)",
        ok,
        detail: ok ? undefined : JSON.stringify(r),
      });
    }

    // 2. register_tecnico — new tecnico A (happy path; both fields present)
    let tecnicoIdA = "";
    {
      const r = await registerTecnico(ctx, {
        phone: PHONE_A,
        nombre: "Smoke Test A",
        ciudad: "Cali",
        especialidades: ["Eléctrico"],
        modalidad: "individual",
        contact_phone: CONTACT_A,
        source: "smoke",
      });
      const ok = r.ok && r.data.created === true;
      if (r.ok) tecnicoIdA = r.data.tecnico_id;
      checks.push({
        name: "register_tecnico A (created)",
        ok,
        detail: ok ? `id=${tecnicoIdA}` : JSON.stringify(r),
      });
    }

    // 3. register_tecnico — same phone again → created:false, same id (idempotent)
    {
      const r = await registerTecnico(ctx, {
        phone: PHONE_A,
        nombre: "Smoke Test A",
        ciudad: "Cali",
        especialidades: ["Eléctrico"],
        modalidad: "solo", // alias for individual
        contact_phone: CONTACT_A,
        source: "smoke",
      });
      const ok = r.ok && r.data.created === false && r.data.tecnico_id === tecnicoIdA;
      checks.push({
        name: "register_tecnico A (idempotent re-register)",
        ok,
        detail: ok ? undefined : JSON.stringify(r),
      });
    }

    // 4. register_tecnico — second técnico B (for concurrent postulaciones sanity)
    let tecnicoIdB = "";
    {
      const r = await registerTecnico(ctx, {
        phone: PHONE_B,
        nombre: "Smoke Test B",
        ciudad: "Cali",
        especialidades: ["Eléctrico"],
        modalidad: "cuadrilla",
        contact_phone: CONTACT_B,
        source: "smoke",
      });
      const ok = r.ok && r.data.created === true;
      if (r.ok) tecnicoIdB = r.data.tecnico_id;
      checks.push({ name: "register_tecnico B", ok, detail: ok ? `id=${tecnicoIdB}` : JSON.stringify(r) });
    }

    // 5. identify_user — after register, A is found
    {
      const r = await identifyUser(ctx, { phone: PHONE_A });
      const ok = r.ok && r.data.found === true && r.data.tecnico.tecnico_id === tecnicoIdA;
      checks.push({ name: "identify_user (found)", ok, detail: ok ? undefined : JSON.stringify(r) });
    }

    // 5a. Force-promote A and B to candidate_state='approved' so create_postulacion
    // can proceed. The smoke verifies the contract pipeline (apply -> shortlist
    // -> contract); the dossier flow has its own coverage in the eval suite.
    // Migration 007 made workers default to 'screening' until HR approves; bypass
    // for testing only.
    {
      const { error } = await supabase
        .from("tecnicos_extended")
        .update({ candidate_state: "approved" })
        .in("tecnico_id", [tecnicoIdA, tecnicoIdB]);
      if (error) throw new Error(`approve test workers failed: ${error.message}`);
    }

    // 6. read_pending_ots — our seeded OT should appear
    {
      const r = await readPendingOts(ctx, { ciudad: "Cali", limit: 50 });
      const has = r.ok && r.data.ots.some((o) => o.ot_id === TEST_OT_ID);
      checks.push({
        name: "read_pending_ots (contains seed)",
        ok: !!has,
        detail: has ? undefined : `returned: ${r.ok ? r.data.ots.length : "err"}`,
      });
    }

    // 7. read_pending_ots with tecnico_id → profile-matched
    {
      const r = await readPendingOts(ctx, { tecnico_id: tecnicoIdA });
      const ok = r.ok && r.data.matched_by_profile === true && r.data.ots.some((o) => o.ot_id === TEST_OT_ID);
      checks.push({ name: "read_pending_ots (profile match)", ok, detail: ok ? undefined : JSON.stringify(r).slice(0, 200) });
    }

    // 8. create_postulacion — A applies
    let postulacionA = "";
    {
      const r = await createPostulacion(ctx, {
        ot_id: TEST_OT_ID,
        tecnico_id: tecnicoIdA,
        mensaje: "smoke apply",
      });
      const ok = r.ok && r.data.state === "postulado";
      if (r.ok) postulacionA = r.data.postulacion_id;
      checks.push({ name: "create_postulacion A", ok, detail: ok ? undefined : JSON.stringify(r) });
    }

    // 9. create_postulacion again (idempotent) → already_applied
    {
      const r = await createPostulacion(ctx, {
        ot_id: TEST_OT_ID,
        tecnico_id: tecnicoIdA,
      });
      const ok = r.ok && r.data.state === "already_applied" && r.data.postulacion_id === postulacionA;
      checks.push({
        name: "create_postulacion A (idempotent)",
        ok,
        detail: ok ? undefined : JSON.stringify(r),
      });
    }

    // 10. create_postulacion B
    {
      const r = await createPostulacion(ctx, {
        ot_id: TEST_OT_ID,
        tecnico_id: tecnicoIdB,
      });
      checks.push({ name: "create_postulacion B", ok: r.ok, detail: r.ok ? undefined : JSON.stringify(r) });
    }

    // 11. read_my_postulaciones
    {
      const r = await readMyPostulaciones(ctx, { tecnico_id: tecnicoIdA });
      const ok =
        r.ok &&
        r.data.postulaciones.length >= 1 &&
        r.data.postulaciones.some((p) => p.postulacion.id === postulacionA);
      checks.push({
        name: "read_my_postulaciones",
        ok,
        detail: ok ? undefined : JSON.stringify(r).slice(0, 200),
      });
    }

    // 12. Transition to preseleccionado (simulates HR action)
    {
      const { error } = await supabase
        .from("postulaciones")
        .update({
          state: "preseleccionado",
          decided_at: new Date().toISOString(),
          decided_by: "hr:smoke",
        })
        .eq("id", postulacionA);
      checks.push({ name: "transition to preseleccionado", ok: !error, detail: error?.message });
    }

    // 13. Create contract (simulates "Generar contrato" on dashboard)
    let contratoId = "";
    {
      const { data, error } = await supabase
        .from("contratos")
        .insert({
          tecnico_id: tecnicoIdA,
          ot_id: TEST_OT_ID,
          status: "borrador",
          created_by: "hr:smoke",
        })
        .select("id")
        .single();
      if (data) contratoId = data.id;
      checks.push({
        name: "create contrato row",
        ok: !error && !!data,
        detail: error?.message ?? `id=${contratoId}`,
      });
    }

    // 14. read_my_contratos — finds the new contract
    {
      const r = await readMyContratos(ctx, { tecnico_id: tecnicoIdA });
      const ok = r.ok && r.data.contratos.some((c) => c.id === contratoId);
      checks.push({
        name: "read_my_contratos",
        ok,
        detail: ok ? undefined : JSON.stringify(r).slice(0, 200),
      });
    }

    // 15. upload_documento (pre-uploaded storage_path path — skips the real upload)
    {
      const fakePath = `${tecnicoIdA}/cedula/smoke-${Date.now()}.pdf`;
      const r = await uploadDocumento(ctx, {
        tecnico_id: tecnicoIdA,
        tipo: "cedula",
        filename: "smoke.pdf",
        storage_path: fakePath,
      });
      checks.push({
        name: "upload_documento (record-only)",
        ok: r.ok,
        detail: r.ok ? undefined : JSON.stringify(r),
      });
    }

    // 16. escalate_to_hr
    {
      const r = await escalateToHr(ctx, {
        tecnico_id: tecnicoIdA,
        phone: PHONE_A,
        reason: "smoke",
        context: "verifying escalation path",
      });
      checks.push({
        name: "escalate_to_hr",
        ok: r.ok,
        detail: r.ok ? `esc=${r.data.escalation_id}` : JSON.stringify(r),
      });
    }

    // 17. log_event
    {
      const r = await logEvent(ctx, {
        type: "smoke_complete",
        meta: { run_id: RUN_ID },
      });
      checks.push({ name: "log_event", ok: r.ok, detail: r.ok ? undefined : JSON.stringify(r) });
    }

    // 18. eventos rows exist — cross-check the HITL measurement signal is alive
    {
      const { data, error } = await supabase
        .from("eventos")
        .select("type")
        .or(`entity_id.eq.${tecnicoIdA},entity_id.eq.${postulacionA},entity_id.eq.${contratoId}`);
      const types = new Set((data ?? []).map((e) => e.type));
      const ok =
        !error &&
        types.has("tecnico_registered") &&
        types.has("postulacion_created") &&
        (types.has("escalation") || types.has("smoke_complete"));
      checks.push({
        name: "eventos recorded (HITL signal)",
        ok,
        detail: ok ? `types=${[...types].join(",")}` : `error=${error?.message} types=${[...types].join(",")}`,
      });
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    checks.push({ name: "uncaught error", ok: false, detail: msg });
  } finally {
    // Cleanup — delete all rows tagged to this run.
    await cleanup(supabase, PHONE_A, PHONE_B, TEST_OT_ID, RUN_ID);
  }

  // Report
  const passed = checks.filter((c) => c.ok).length;
  const failed = checks.filter((c) => !c.ok);
  const banner = "═".repeat(60);
  console.log("\n" + banner);
  console.log(`PHASE 0 SMOKE — ${RUN_ID}`);
  console.log(banner);
  for (const c of checks) {
    const icon = c.ok ? "PASS" : "FAIL";
    console.log(`[${icon}] ${c.name}${c.detail ? ` — ${c.detail}` : ""}`);
  }
  console.log(banner);
  console.log(`${passed}/${checks.length} checks passed${failed.length ? `, ${failed.length} failed` : ""}`);
  console.log(banner + "\n");
  if (failed.length > 0) {
    process.exit(1);
  }
}

async function cleanup(
  supabase: ServerClient,
  phoneA: string,
  phoneB: string,
  otId: string,
  runId: string
) {
  // 1. Delete contratos + postulaciones linked to the test OT
  await supabase.from("contratos").delete().eq("ot_id", otId);
  await supabase.from("postulaciones").delete().eq("ot_id", otId);
  // 2. Delete the test OT
  await supabase.from("ots_mirror").delete().eq("row_id", otId);
  // 3. Find the test técnicos and delete their documentos / eventos
  const { data: tecs } = await supabase
    .from("tecnicos_extended")
    .select("tecnico_id")
    .in("phone", [phoneA, phoneB]);
  const ids = (tecs ?? []).map((t) => t.tecnico_id);
  if (ids.length > 0) {
    await supabase.from("documentos").delete().in("tecnico_id", ids);
    await supabase.from("contratos").delete().in("tecnico_id", ids);
    await supabase.from("postulaciones").delete().in("tecnico_id", ids);
    await supabase.from("eventos").delete().in("entity_id", ids);
  }
  await supabase.from("tecnicos_extended").delete().in("phone", [phoneA, phoneB]);
  // 4. Delete smoke_complete event tagged with run_id
  await supabase.from("eventos").delete().eq("type", "smoke_complete").like("meta->>run_id", runId);
}

main().catch((e) => {
  log.error("smoke fatal", { error: e instanceof Error ? e.message : String(e) });
  process.exit(1);
});
