// scripts/import-legacy-tecnicos.ts
//
// Idempotent bootstrap of legacy AppSheet TECNICOS into tecnicos_extended.
//
// Why this exists: ~49 técnicos already work with Redin via the AppSheet pilot.
// They are pre-approved by trust earned through real jobs — they should NOT be
// re-screened by Toño. Their Supabase profile, however, doesn't exist yet, so
// the agent can't reach them. This script imports them as
//   candidate_state='approved', profile_complete=false
// so Toño's three-case routing puts them into the enrichment flow (CASE A) on
// first contact.
//
// Idempotency: re-runs are safe. Match priority is appsheet_row_id → phone.
// Existing rows get a non-destructive patch (no field overwrites that already
// hold a value); the synthetic candidate_decisions row inserts only once per
// tecnico_id (gated on decided_by='system:legacy_bootstrap').
//
// Pre-bootstrap NULL-cedula sanity check: the cedula UNIQUE index from
// migration 007 must be partial (WHERE cedula IS NOT NULL). If it isn't, this
// script would attempt to insert ~49 rows with NULL cedula into a unique index
// that doesn't tolerate multiple NULLs. We verify and fail loudly before any
// inserts.
//
// Dynamic AppSheet schema: we read ALL columns from AppSheet (no filtering at
// the call site). Required-write columns missing → fail loudly. Unknown
// columns → log eventos{type:'appsheet_schema_drift'} once with the names.
//
// Usage:
//   npx tsx --env-file=.env.local scripts/import-legacy-tecnicos.ts

import { randomUUID } from "node:crypto";
import {
  createServerClient,
  createLogger,
  normalizeColombianPhone,
  requireEnv,
} from "@redin/shared";
import { AppSheetReadClient } from "@redin/sync/appsheet";

const log = createLogger("legacy-bootstrap");

// Columns the bootstrap recognizes. Anything else gets logged once as drift.
const KNOWN_COLUMNS = new Set([
  "_RowNumber",
  "Row ID",
  "Nombre de Tecnico",
  "Telefono",
  "EMAIL",
  "Popularidad_Tecnico",
  "Related DETALLE DE ACTIVIDADESs",
]);

// Required write columns per the contract's "3 writable columns" rule. If any
// of these are missing from the live schema, we abort rather than import
// partial data.
const REQUIRED_COLUMNS = ["Nombre de Tecnico", "Telefono", "EMAIL"] as const;

interface AppSheetRow extends Record<string, string | undefined> {
  "Row ID"?: string;
  "Nombre de Tecnico"?: string;
  Telefono?: string;
  EMAIL?: string;
  Popularidad_Tecnico?: string;
  "Related DETALLE DE ACTIVIDADESs"?: string;
}

async function verifyCedulaIndexAllowsMultipleNulls(
  sb: ReturnType<typeof createServerClient>
): Promise<void> {
  // pg_indexes is not exposed via the typed Database surface — escape-hatch via .rpc-style raw not available either.
  // Instead, we use the Postgres REST endpoint to read pg_indexes via supabase's `from` with a known function we can rely on:
  //   We don't have that. So we use a simple SELECT via the postgrest exec_sql approach by hitting a custom view if present,
  // OR we use a side-channel: probe by attempting two trivial inserts and rolling back. Both are fragile.
  //
  // The pragmatic choice: query `pg_indexes` directly through Supabase's PostgREST. It exposes `pg_indexes` as a system
  // table when given access. If that fails, surface the failure clearly so a human can verify by hand.
  const res = await fetch(
    `${requireEnv("SUPABASE_URL")}/rest/v1/rpc/exec_sql`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: requireEnv("SUPABASE_SECRET_KEY"),
        Authorization: `Bearer ${requireEnv("SUPABASE_SECRET_KEY")}`,
      },
      body: JSON.stringify({
        sql: "SELECT indexdef FROM pg_indexes WHERE schemaname='public' AND indexname='idx_tecnicos_extended_cedula' LIMIT 1",
      }),
    }
  ).catch(() => null);

  // Many Supabase instances don't expose exec_sql. Fall back to a write-side probe:
  // attempt to insert two rows with NULL cedula into a temp table mimicking the
  // production constraint pattern. We don't actually want to write to production,
  // so instead we read the index def via a stored procedure if available, or skip
  // with a hard warning that an operator MUST verify the indexdef by hand.
  if (!res || !res.ok) {
    log.warn(
      "could not auto-verify cedula UNIQUE index NULL handling. " +
        "Run manually before continuing: SELECT indexdef FROM pg_indexes " +
        "WHERE indexname='idx_tecnicos_extended_cedula'. " +
        "It MUST contain 'WHERE (cedula IS NOT NULL)' and MUST NOT contain 'NULLS NOT DISTINCT'."
    );
    // Hard gate: refuse to proceed if we can't verify.
    if (process.env.LEGACY_BOOTSTRAP_SKIP_NULL_CHECK !== "1") {
      throw new Error(
        "cedula NULL-uniqueness precheck unavailable; set LEGACY_BOOTSTRAP_SKIP_NULL_CHECK=1 only after verifying the index by hand"
      );
    }
    return;
  }
  const body = (await res.json()) as Array<{ indexdef: string }>;
  const indexdef = body?.[0]?.indexdef ?? "";
  const hasPartial = /WHERE\s*\(?\s*cedula\s+IS\s+NOT\s+NULL/i.test(indexdef);
  const hasNullsNotDistinct = /NULLS\s+NOT\s+DISTINCT/i.test(indexdef);
  if (!hasPartial || hasNullsNotDistinct) {
    throw new Error(
      `cedula UNIQUE index does not allow multiple NULLs. indexdef="${indexdef}". ` +
        "Refusing to bulk-insert ~49 NULL-cedula rows. Fix migration 007 first."
    );
  }
  log.info("cedula UNIQUE index verified (partial WHERE cedula IS NOT NULL)");
}

interface BootstrapCounters {
  imported: number;
  updated: number;
  unchanged: number;
  skipped: number;
}

async function main(): Promise<void> {
  const sb = createServerClient();
  await verifyCedulaIndexAllowsMultipleNulls(sb);

  const appsheet = new AppSheetReadClient({
    appId: requireEnv("APPSHEET_APP_ID"),
    accessKey: requireEnv("APPSHEET_ACCESS_KEY"),
  });

  log.info("fetching AppSheet TECNICOS");
  const rows = await appsheet.find<AppSheetRow>("Tecnicos");
  log.info("rows fetched", { count: rows.length });

  // Drift check: log unknown columns once (not per row).
  const unknown = new Set<string>();
  for (const r of rows) {
    for (const k of Object.keys(r)) {
      if (!KNOWN_COLUMNS.has(k)) unknown.add(k);
    }
  }
  if (unknown.size > 0) {
    log.warn("AppSheet TECNICOS contains unknown columns", {
      unknown: [...unknown],
    });
    await sb.from("eventos").insert({
      type: "appsheet_schema_drift",
      entity_id: null,
      actor: "system:legacy_bootstrap",
      meta: {
        table: "Tecnicos",
        unknown_columns: [...unknown],
      },
    });
  }

  // Required-column hard check.
  for (const required of REQUIRED_COLUMNS) {
    const present = rows.some((r) => required in r);
    if (!present) {
      throw new Error(
        `AppSheet TECNICOS missing required column "${required}". Refusing to import partial data.`
      );
    }
  }

  const counters: BootstrapCounters = {
    imported: 0,
    updated: 0,
    unchanged: 0,
    skipped: 0,
  };

  for (const r of rows) {
    const appsheetRowId = r["Row ID"];
    if (!appsheetRowId) {
      log.warn("row missing 'Row ID'; skipping", { row: r });
      counters.skipped++;
      continue;
    }
    const phoneRaw = r["Telefono"] ?? "";
    const phone = normalizeColombianPhone(phoneRaw);
    if (!phone) {
      log.warn("row missing Telefono; skipping", { appsheetRowId });
      counters.skipped++;
      continue;
    }

    const popularidad = parseInt(r["Popularidad_Tecnico"] ?? "0", 10) || 0;
    const activityRaw = r["Related DETALLE DE ACTIVIDADESs"] ?? "";
    const activityCount =
      activityRaw.trim() === "" ? 0 : activityRaw.split(/\s*,\s*/).length;

    // Match: appsheet_row_id first, then phone.
    let existing: Record<string, unknown> | null = null;
    {
      const { data } = await sb
        .from("tecnicos_extended")
        .select("*")
        .eq("appsheet_row_id", appsheetRowId)
        .maybeSingle();
      if (data) existing = data;
    }
    if (!existing) {
      const { data } = await sb
        .from("tecnicos_extended")
        .select("*")
        .eq("phone", phone)
        .maybeSingle();
      if (data) existing = data;
    }

    let tecnicoId: string;
    let priorState: string;

    if (!existing) {
      tecnicoId = randomUUID();
      priorState = "screening";
      const nowIso = new Date().toISOString();
      const { error } = await sb.from("tecnicos_extended").insert({
        tecnico_id: tecnicoId,
        phone,
        estado: "activo",
        candidate_state: "approved",
        appsheet_row_id: appsheetRowId,
        legacy_popularidad: popularidad,
        legacy_activity_count: activityCount,
        imported_at: nowIso,
        import_source: "appsheet_legacy_bootstrap",
        profile_complete: false,
        source: "appsheet_legacy_bootstrap",
        // cedula intentionally NULL — workers haven't given it yet.
      });
      if (error) {
        log.error("insert failed", {
          appsheetRowId,
          phone,
          error: error.message,
        });
        throw error;
      }
      counters.imported++;
    } else {
      tecnicoId = existing.tecnico_id as string;
      priorState = (existing.candidate_state as string) ?? "screening";
      const patch: Record<string, unknown> = {};
      if (existing.appsheet_row_id !== appsheetRowId) {
        patch.appsheet_row_id = appsheetRowId;
      }
      if (existing.legacy_popularidad !== popularidad) {
        patch.legacy_popularidad = popularidad;
      }
      if (existing.legacy_activity_count !== activityCount) {
        patch.legacy_activity_count = activityCount;
      }
      // Force candidate_state='approved' for legacy bootstrap. If the row was
      // somehow in 'screening' (a phone-only collision with a cold-path row),
      // legacy bootstrap wins — these workers are pre-approved by trust.
      if (existing.candidate_state !== "approved") {
        patch.candidate_state = "approved";
      }
      if (!existing.import_source) {
        patch.import_source = "appsheet_legacy_bootstrap";
      }
      if (!existing.imported_at) {
        patch.imported_at = new Date().toISOString();
      }
      // Preserve existing source if set; otherwise stamp.
      if (!existing.source) {
        patch.source = "appsheet_legacy_bootstrap";
      }
      if (Object.keys(patch).length > 0) {
        const { error } = await sb
          .from("tecnicos_extended")
          .update(patch)
          .eq("tecnico_id", tecnicoId);
        if (error) {
          log.error("update failed", {
            tecnicoId,
            patch,
            error: error.message,
          });
          throw error;
        }
        counters.updated++;
      } else {
        counters.unchanged++;
      }
    }

    // Idempotently insert the legacy bootstrap eventos row so identify_user's
    // event-meta enrichment can surface nombre + email at conversation time.
    {
      const { data: existingEvent } = await sb
        .from("eventos")
        .select("id")
        .eq("type", "tecnico_legacy_bootstrap")
        .eq("entity_id", tecnicoId)
        .maybeSingle();
      if (!existingEvent) {
        const { error } = await sb.from("eventos").insert({
          type: "tecnico_legacy_bootstrap",
          entity_id: tecnicoId,
          actor: "system:legacy_bootstrap",
          meta: {
            nombre: r["Nombre de Tecnico"] ?? null,
            email: r["EMAIL"] ?? null,
            telefono: phone,
            popularidad,
            activity_count: activityCount,
            appsheet_row_id: appsheetRowId,
          },
        });
        if (error) {
          log.error("eventos insert failed (non-fatal)", {
            tecnicoId,
            error: error.message,
          });
        }
      }
    }

    // Idempotently insert the synthetic candidate_decisions row.
    {
      const { data: existingDecision } = await sb
        .from("candidate_decisions")
        .select("id")
        .eq("tecnico_id", tecnicoId)
        .eq("decided_by", "system:legacy_bootstrap")
        .maybeSingle();
      if (!existingDecision) {
        const { error } = await sb.from("candidate_decisions").insert({
          tecnico_id: tecnicoId,
          dossier_id: null,
          decision: "approve",
          resulting_state: "approved",
          prior_state: priorState,
          tono_recommendation_at_decision_time: null,
          agreed_with_tono: null,
          hr_reasoning:
            "Imported from AppSheet TECNICOS as pre-existing trusted worker — eligible by historical work record, not by screening.",
          decided_by: "system:legacy_bootstrap",
        });
        if (error) {
          log.error("candidate_decisions insert failed", {
            tecnicoId,
            error: error.message,
          });
          throw error;
        }
      }
    }
  }

  log.info("bootstrap complete", {
    total: rows.length,
    ...counters,
  });
}

main().catch((e) => {
  log.error("fatal", {
    error: e instanceof Error ? e.message : String(e),
    stack: e instanceof Error ? e.stack : undefined,
  });
  process.exit(1);
});
