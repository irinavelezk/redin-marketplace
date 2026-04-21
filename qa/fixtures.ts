/**
 * qa/fixtures.ts — DB seed/cleanup helpers for the S07 eval harness.
 *
 * All test rows use:
 *   phone:      "+99000" + 7-digit suffix  (e.g. +990001000001)
 *   tecnico_id: "TEST_" prefix             (e.g. TEST_bogel01)
 *   ot_id:      "TEST_OT_" prefix          (e.g. TEST_OT_bogota_elec_001)
 *
 * cleanupTestData() deletes every row matching these prefixes so the DB stays
 * clean between runs and on --clean invocations.
 */

import { createServerClient } from "@redin/shared";
import type { DBFixture } from "./seeds/schema.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FixtureRefs {
  tecnico_id: string | null;
  ot_ids: string[];
}

// ---------------------------------------------------------------------------
// Phone allocator — deterministic per seed run
// ---------------------------------------------------------------------------

let phoneCounter = 1_000_000;

export function allocateTestPhone(): string {
  const suffix = String(phoneCounter++).padStart(7, "0");
  return `+99000${suffix}`;
}

// ---------------------------------------------------------------------------
// Individual fixture seeders
// ---------------------------------------------------------------------------

async function seedTecnicoNotRegistered(
  _testPhone: string
): Promise<FixtureRefs> {
  // "not registered" = no rows needed. Phone is fresh.
  return { tecnico_id: null, ot_ids: [] };
}

async function seedTecnicoRegisteredBogotaElectrico(
  testPhone: string
): Promise<FixtureRefs> {
  const supabase = createServerClient();
  const tecnico_id = `TEST_bogel01_${testPhone.slice(-6)}`;

  // tecnicos_extended columns: tecnico_id, phone, lider_phone, estado, onboarded_at, source, appsheet_synced_at
  const { error: extErr } = await supabase.from("tecnicos_extended").upsert({
    tecnico_id,
    phone: testPhone,
    estado: "activo",
    source: "warm",
  });
  if (extErr) throw new Error(`fixture tecnicos_extended bogota_electrico: ${extErr.message}`);

  // tecnicos_mirror columns: row_id, data, synced_at (no flat cols — all data in jsonb)
  const { error: mirrorErr } = await supabase.from("tecnicos_mirror").upsert({
    row_id: tecnico_id,
    data: {
      "Row ID": tecnico_id,
      Nombre: "Juan Rodriguez",
      Especialidad: "eléctrico",
      Modalidad: "prestación",
      Ciudad: "Bogotá",
      Teléfono: testPhone,
    },
  });
  if (mirrorErr) throw new Error(`fixture tecnicos_mirror bogota_electrico: ${mirrorErr.message}`);

  // Insert a tecnico_registered event so read_pending_ots(tecnico_id) can profile-match.
  // Upsert via (type, entity_id) — events table has no unique constraint, so we
  // delete the old one first to stay idempotent.
  await supabase
    .from("eventos")
    .delete()
    .eq("type", "tecnico_registered")
    .eq("entity_id", tecnico_id);
  const { error: evtErr } = await supabase.from("eventos").insert({
    type: "tecnico_registered",
    entity_id: tecnico_id,
    actor: "agent",
    meta: {
      ciudad: "Bogotá",
      especialidades: ["eléctrico"],
      modalidad: "solo",
      nombre: "Juan Rodriguez",
      phone: testPhone,
    },
  });
  if (evtErr) throw new Error(`fixture eventos bogota_electrico: ${evtErr.message}`);

  return { tecnico_id, ot_ids: [] };
}

async function seedTecnicoRegisteredCaliPlomero(
  testPhone: string
): Promise<FixtureRefs> {
  const supabase = createServerClient();
  const tecnico_id = `TEST_calpl01_${testPhone.slice(-6)}`;

  const { error: extErr } = await supabase.from("tecnicos_extended").upsert({
    tecnico_id,
    phone: testPhone,
    estado: "activo",
    source: "warm",
  });
  if (extErr) throw new Error(`fixture tecnicos_extended cali_plomero: ${extErr.message}`);

  const { error: mirrorErr } = await supabase.from("tecnicos_mirror").upsert({
    row_id: tecnico_id,
    data: {
      "Row ID": tecnico_id,
      Nombre: "Carlos Mendez",
      Especialidad: "plomería",
      Modalidad: "prestación",
      Ciudad: "Cali",
      Teléfono: testPhone,
    },
  });
  if (mirrorErr) throw new Error(`fixture tecnicos_mirror cali_plomero: ${mirrorErr.message}`);

  // Insert tecnico_registered event for profile-matching in read_pending_ots.
  await supabase
    .from("eventos")
    .delete()
    .eq("type", "tecnico_registered")
    .eq("entity_id", tecnico_id);
  const { error: evtErr } = await supabase.from("eventos").insert({
    type: "tecnico_registered",
    entity_id: tecnico_id,
    actor: "agent",
    meta: {
      ciudad: "Cali",
      especialidades: ["plomería"],
      modalidad: "solo",
      nombre: "Carlos Mendez",
      phone: testPhone,
    },
  });
  if (evtErr) throw new Error(`fixture eventos cali_plomero: ${evtErr.message}`);

  return { tecnico_id, ot_ids: [] };
}

async function seedTecnicoWithPendingPostulacion(
  testPhone: string
): Promise<FixtureRefs> {
  const supabase = createServerClient();
  const refs = await seedTecnicoRegisteredBogotaElectrico(testPhone);
  const tecnico_id = refs.tecnico_id!;
  const ot_id = `TEST_OT_pending_${testPhone.slice(-6)}`;

  const { error: otErr } = await supabase.from("ots_mirror").upsert({
    row_id: ot_id,
    data: {
      "Row ID": ot_id,
      Descripcion: "TEST OT — instalación eléctrica Bogotá",
      Ciudad: "Bogotá",
      Categoria: "eléctrico",
      Estado: "pendiente",
    },
    ciudad: "Bogotá",
    especialidad: "eléctrico",
    estado: "pendiente",
  });
  if (otErr) throw new Error(`fixture ots_mirror pending: ${otErr.message}`);

  // Idempotent: delete before insert to avoid duplicate (ot_id, tecnico_id) constraint.
  await supabase
    .from("postulaciones")
    .delete()
    .eq("ot_id", ot_id)
    .eq("tecnico_id", tecnico_id);
  const { error: postErr } = await supabase.from("postulaciones").insert({
    ot_id,
    tecnico_id,
    state: "postulado",
    mensaje: "TEST postulacion",
  });
  if (postErr) throw new Error(`fixture postulaciones pending: ${postErr.message}`);

  return { tecnico_id, ot_ids: [ot_id] };
}

async function seedTecnicoWithSignedContract(
  testPhone: string
): Promise<FixtureRefs> {
  const supabase = createServerClient();
  const refs = await seedTecnicoRegisteredBogotaElectrico(testPhone);
  const tecnico_id = refs.tecnico_id!;
  const ot_id = `TEST_OT_signed_${testPhone.slice(-6)}`;

  const { error: otErr } = await supabase.from("ots_mirror").upsert({
    row_id: ot_id,
    data: {
      "Row ID": ot_id,
      Descripcion: "TEST OT — contrato firmado",
      Ciudad: "Bogotá",
      Categoria: "eléctrico",
      Estado: "asignado",
    },
    ciudad: "Bogotá",
    especialidad: "eléctrico",
    estado: "asignado",
  });
  if (otErr) throw new Error(`fixture ots_mirror signed: ${otErr.message}`);

  // Idempotent: delete before insert (contratos has no unique constraint on tecnico_id+ot_id).
  await supabase
    .from("contratos")
    .delete()
    .eq("tecnico_id", tecnico_id)
    .eq("ot_id", ot_id);
  const { error: ctrErr } = await supabase.from("contratos").insert({
    tecnico_id,
    ot_id,
    status: "firmado",
    created_by: "hr:test",
  });
  if (ctrErr) throw new Error(`fixture contratos signed: ${ctrErr.message}`);

  return { tecnico_id, ot_ids: [ot_id] };
}

async function seedOpenOtBogotaElectrico(
  testPhone: string
): Promise<FixtureRefs> {
  const supabase = createServerClient();
  const ot_id = `TEST_OT_bogel_${testPhone.slice(-6)}`;

  await supabase.from("ots_mirror").upsert({
    row_id: ot_id,
    data: {
      "Row ID": ot_id,
      Descripcion: "TEST OT — instalación eléctrica residencial Bogotá",
      Ciudad: "Bogotá",
      Categoria: "eléctrico",
      Estado: "pendiente",
    },
    ciudad: "Bogotá",
    especialidad: "eléctrico",
    estado: "pendiente",
  });

  return { tecnico_id: null, ot_ids: [ot_id] };
}

async function seedOpenOtNeivaPlomero(
  testPhone: string
): Promise<FixtureRefs> {
  const supabase = createServerClient();
  const ot_id = `TEST_OT_neipl_${testPhone.slice(-6)}`;

  await supabase.from("ots_mirror").upsert({
    row_id: ot_id,
    data: {
      "Row ID": ot_id,
      Descripcion: "TEST OT — reparación plomería Neiva",
      Ciudad: "Neiva",
      Categoria: "plomería",
      Estado: "pendiente",
    },
    ciudad: "Neiva",
    especialidad: "plomería",
    estado: "pendiente",
  });

  return { tecnico_id: null, ot_ids: [ot_id] };
}

async function seedOpenOtCaliPlomero(
  testPhone: string
): Promise<FixtureRefs> {
  const supabase = createServerClient();
  const ot_id = `TEST_OT_calpl_${testPhone.slice(-6)}`;

  await supabase.from("ots_mirror").upsert({
    row_id: ot_id,
    data: {
      "Row ID": ot_id,
      Descripcion: "TEST OT — reparación plomería Cali",
      Ciudad: "Cali",
      Categoria: "plomería",
      Estado: "pendiente",
    },
    ciudad: "Cali",
    especialidad: "plomería",
    estado: "pendiente",
  });

  return { tecnico_id: null, ot_ids: [ot_id] };
}

async function seedMultipleOpenOtsBogota(
  testPhone: string
): Promise<FixtureRefs> {
  const supabase = createServerClient();
  const ot_ids: string[] = [];

  // Insert 51 OTs — enough to trigger the ≥50 truncation rule (router postDispatch).
  const rows = Array.from({ length: 51 }, (_, i) => {
    const ot_id = `TEST_OT_multi_${testPhone.slice(-6)}_${String(i).padStart(3, "0")}`;
    ot_ids.push(ot_id);
    return {
      row_id: ot_id,
      data: {
        "Row ID": ot_id,
        Descripcion: `TEST OT multi ${i} — Bogotá eléctrico`,
        Ciudad: "Bogotá",
        Categoria: "eléctrico",
        Estado: "pendiente",
      },
      ciudad: "Bogotá",
      especialidad: "eléctrico",
      estado: "pendiente",
    };
  });

  // Batch insert in chunks of 20 to avoid payload limits.
  for (let i = 0; i < rows.length; i += 20) {
    const chunk = rows.slice(i, i + 20);
    await supabase.from("ots_mirror").upsert(chunk);
  }

  return { tecnico_id: null, ot_ids };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const SEEDERS: Record<
  DBFixture,
  (testPhone: string) => Promise<FixtureRefs>
> = {
  tecnico_not_registered: seedTecnicoNotRegistered,
  tecnico_registered_bogota_electrico: seedTecnicoRegisteredBogotaElectrico,
  tecnico_registered_cali_plomero: seedTecnicoRegisteredCaliPlomero,
  tecnico_with_pending_postulacion: seedTecnicoWithPendingPostulacion,
  tecnico_with_signed_contract: seedTecnicoWithSignedContract,
  open_ot_bogota_electrico: seedOpenOtBogotaElectrico,
  open_ot_neiva_plomero: seedOpenOtNeivaPlomero,
  open_ot_cali_plomero: seedOpenOtCaliPlomero,
  multiple_open_ots_bogota: seedMultipleOpenOtsBogota,
};

/**
 * Apply a list of DB fixtures for a given test phone. Returns merged refs
 * (last non-null tecnico_id wins; all ot_ids collected).
 */
export async function applyFixtures(
  fixtures: DBFixture[],
  testPhone: string
): Promise<FixtureRefs> {
  const merged: FixtureRefs = { tecnico_id: null, ot_ids: [] };
  for (const fixture of fixtures) {
    const seeder = SEEDERS[fixture];
    const refs = await seeder(testPhone);
    if (refs.tecnico_id !== null) merged.tecnico_id = refs.tecnico_id;
    merged.ot_ids.push(...refs.ot_ids);
  }
  return merged;
}

/**
 * Delete all test rows matching the TEST_ / +99000 prefixes from all tables.
 * Safe to call multiple times (idempotent deletes).
 */
export async function cleanupTestData(): Promise<void> {
  const supabase = createServerClient();

  // Collect TEST_ tecnico_ids for cascading deletes.
  const { data: tecs } = await supabase
    .from("tecnicos_extended")
    .select("tecnico_id")
    .like("phone", "+99000%");

  const ids = (tecs ?? []).map((t) => t.tecnico_id);

  // Also collect any TEST_-prefixed tecnico_ids directly.
  const { data: testTecs } = await supabase
    .from("tecnicos_extended")
    .select("tecnico_id")
    .like("tecnico_id", "TEST_%");

  const testIds = (testTecs ?? []).map((t) => t.tecnico_id);
  const allIds = [...new Set([...ids, ...testIds])];

  // Delete child rows first (FK order).
  if (allIds.length > 0) {
    await supabase.from("documentos").delete().in("tecnico_id", allIds);
    await supabase.from("contratos").delete().in("tecnico_id", allIds);
    await supabase.from("postulaciones").delete().in("tecnico_id", allIds);
    await supabase.from("eventos").delete().in("entity_id", allIds);
    await supabase.from("tecnicos_mirror").delete().in("row_id", allIds);
  }

  // Delete TEST_OT_ rows from ots_mirror + associated postulaciones/contratos.
  await supabase.from("postulaciones").delete().like("ot_id", "TEST_OT_%");
  await supabase.from("contratos").delete().like("ot_id", "TEST_OT_%");
  await supabase.from("ots_mirror").delete().like("row_id", "TEST_OT_%");

  // Delete sessions + messages for test phones.
  const { data: sessions } = await supabase
    .from("sessions")
    .select("id")
    .like("phone", "+99000%");

  const sessionIds = (sessions ?? []).map((s) => s.id);
  if (sessionIds.length > 0) {
    await supabase.from("messages").delete().in("session_id", sessionIds);
    await supabase.from("sessions").delete().in("id", sessionIds);
  }

  // Finally delete tecnicos_extended rows.
  await supabase.from("tecnicos_extended").delete().like("phone", "+99000%");
  await supabase.from("tecnicos_extended").delete().like("tecnico_id", "TEST_%");
}
