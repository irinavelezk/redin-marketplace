// AppSheet TECNICOS reverse-projection — drainer.
//
// Per docs/architecture/onboarding-contracts.md §8:
//   - approved candidates → AppSheet Add (find-by-name first; capture Row ID
//     without Add if a row with the same name already exists; ambiguous-name
//     escalates to Telegram).
//   - revoked candidates → AppSheet Delete by Row ID. Re-deletes (404) treated
//     as success.
//
// Concurrency:
//   - Single-instance projector per contract §14.1.
//   - In-process Set<tecnico_id> guards against re-entrant ticks (e.g., manual
//     SIGUSR1 overlapping the cron).
//   - DB CAS on appsheet_sync_attempts as belt-and-braces against accidental
//     multi-instance (Railway redeploy overlap, dev-against-prod).
//
// Failure handling:
//   - Bumps appsheet_sync_attempts on every failed dispatch (incl. ambiguous_name).
//   - At attempt 3, sends a louder Telegram ping; the dashboard's per-worker
//     warning banner surfaces appsheet_sync_last_error in the operator's UI.

import { createLogger } from "@redin/shared";
import type { ServerClient } from "@redin/shared";
import type { AppSheetReadClient } from "./appsheet";
import type { TelegramSink } from "./telegram";

const log = createLogger("sync:projector");

const inFlight = new Set<string>();

export interface ProjectorTickDeps {
  supa: ServerClient;
  appsheet: AppSheetReadClient;
  telegram?: TelegramSink;
  // Optional override for testing — defaults to 3.
  failureEscalationThreshold?: number;
}

export type ProjectorAction =
  | "added"
  | "found_existing"
  | "deleted"
  | "skipped"
  | "skipped_already_gone";

export interface ProjectorTickResult {
  tecnico_id: string;
  action: ProjectorAction;
  appsheet_row_id?: string;
  attempts: number;
  error?: string;
}

interface CandidateRow {
  tecnico_id: string;
  phone: string;
  candidate_state: string;
  appsheet_row_id: string | null;
  appsheet_sync_attempts: number;
}

const ATTEMPTS_LIMIT = 3;

export async function tickOnce(
  deps: ProjectorTickDeps
): Promise<ProjectorTickResult[]> {
  const threshold = deps.failureEscalationThreshold ?? 3;

  // Pull deletes first (frees names so a re-Add of a different worker with
  // the same name doesn't get blocked by the stale row).
  const [deletesRes, addsRes] = await Promise.all([
    deps.supa
      .from("tecnicos_extended")
      .select(
        "tecnico_id, phone, candidate_state, appsheet_row_id, appsheet_sync_attempts"
      )
      .eq("appsheet_delete_pending", true)
      .lt("appsheet_sync_attempts", ATTEMPTS_LIMIT)
      .limit(5),
    deps.supa
      .from("tecnicos_extended")
      .select(
        "tecnico_id, phone, candidate_state, appsheet_row_id, appsheet_sync_attempts"
      )
      .eq("appsheet_sync_pending", true)
      .lt("appsheet_sync_attempts", ATTEMPTS_LIMIT)
      .limit(5),
  ]);

  const deleteIds = new Set(
    (deletesRes.data ?? []).map((r) => r.tecnico_id as string)
  );
  const all: CandidateRow[] = [
    ...(deletesRes.data ?? []),
    ...(addsRes.data ?? []).filter(
      (r) => !deleteIds.has(r.tecnico_id as string)
    ),
  ] as CandidateRow[];

  const results: ProjectorTickResult[] = [];
  for (const row of all) {
    if (inFlight.has(row.tecnico_id)) continue;
    inFlight.add(row.tecnico_id);
    try {
      // Belt-and-braces: claim the work via CAS on appsheet_sync_attempts.
      // If another instance already bumped it, count=0 → skip this row.
      const { data: claimed, error: claimErr } = await deps.supa
        .from("tecnicos_extended")
        .update({ appsheet_sync_attempts: row.appsheet_sync_attempts + 1 })
        .eq("tecnico_id", row.tecnico_id)
        .eq("appsheet_sync_attempts", row.appsheet_sync_attempts)
        .select("tecnico_id");
      if (claimErr) {
        log.warn("CAS claim failed", {
          tecnico_id: row.tecnico_id,
          error: claimErr.message,
        });
        results.push({
          tecnico_id: row.tecnico_id,
          action: "skipped",
          attempts: row.appsheet_sync_attempts,
          error: `claim_failed: ${claimErr.message}`,
        });
        continue;
      }
      if (!claimed || claimed.length === 0) {
        // Another worker grabbed it — leave silently.
        results.push({
          tecnico_id: row.tecnico_id,
          action: "skipped",
          attempts: row.appsheet_sync_attempts,
          error: "claim_lost",
        });
        continue;
      }

      const claimedAttempts = row.appsheet_sync_attempts + 1;
      const isDelete = deleteIds.has(row.tecnico_id);
      const result = isDelete
        ? await processDelete(deps, row, claimedAttempts, threshold)
        : await processAdd(deps, row, claimedAttempts, threshold);
      results.push(result);
    } finally {
      inFlight.delete(row.tecnico_id);
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Add path
// ---------------------------------------------------------------------------

async function processAdd(
  deps: ProjectorTickDeps,
  row: CandidateRow,
  attempts: number,
  threshold: number
): Promise<ProjectorTickResult> {
  // Resolve nombre from the latest tecnico_registered evento.
  const { data: regEvent } = await deps.supa
    .from("eventos")
    .select("meta")
    .eq("type", "tecnico_registered")
    .eq("entity_id", row.tecnico_id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const nombre = extractString(regEvent?.meta, "nombre");
  if (!nombre) {
    await markFailure(
      deps,
      row.tecnico_id,
      "no_nombre_in_registered_event",
      attempts,
      threshold
    );
    return {
      tecnico_id: row.tecnico_id,
      action: "skipped",
      attempts,
      error: "no_nombre",
    };
  }

  try {
    const found = await deps.appsheet.findTecnicoByName(nombre);

    if (found.length === 1) {
      const rowId = found[0]!["Row ID"];
      if (!rowId) {
        await markFailure(
          deps,
          row.tecnico_id,
          "find_returned_row_without_row_id",
          attempts,
          threshold
        );
        return {
          tecnico_id: row.tecnico_id,
          action: "skipped",
          attempts,
          error: "missing_row_id",
        };
      }
      await deps.supa
        .from("tecnicos_extended")
        .update({
          appsheet_row_id: rowId,
          appsheet_sync_pending: false,
          appsheet_synced_at: new Date().toISOString(),
          appsheet_sync_last_error: null,
        })
        .eq("tecnico_id", row.tecnico_id);
      await deps.supa.from("eventos").insert({
        type: "appsheet_add_skipped_existing",
        entity_id: row.tecnico_id,
        actor: "system:projector",
        meta: { row_id: rowId, nombre, attempts },
      });
      log.info("found existing AppSheet row", {
        tecnico_id: row.tecnico_id,
        row_id: rowId,
        nombre,
      });
      return {
        tecnico_id: row.tecnico_id,
        action: "found_existing",
        appsheet_row_id: rowId,
        attempts,
      };
    }

    if (found.length > 1) {
      // Ambiguous — escalate, leave pending. The per-worker dashboard page
      // surfaces the warning banner so HR sees this in the dashboard, not
      // only in Telegram.
      await deps.telegram?.send(
        `AppSheet ambiguous-name: "${nombre}" matches ${found.length} rows; tecnico_id=${row.tecnico_id} (intento ${attempts})`
      );
      const errMsg = `ambiguous_name(${found.length})`;
      await markFailure(deps, row.tecnico_id, errMsg, attempts, threshold);
      return {
        tecnico_id: row.tecnico_id,
        action: "skipped",
        attempts,
        error: errMsg,
      };
    }

    // 0 results → Add.
    const added = await deps.appsheet.addTecnico({
      "Nombre de Tecnico": nombre,
      Telefono: row.phone,
      EMAIL: "",
    });
    const newRowId = added["Row ID"];
    if (!newRowId) {
      throw new Error("AppSheet Add returned without Row ID");
    }
    await deps.supa
      .from("tecnicos_extended")
      .update({
        appsheet_row_id: newRowId,
        appsheet_sync_pending: false,
        appsheet_synced_at: new Date().toISOString(),
        appsheet_sync_last_error: null,
      })
      .eq("tecnico_id", row.tecnico_id);
    await deps.supa.from("eventos").insert({
      type: "appsheet_added",
      entity_id: row.tecnico_id,
      actor: "system:projector",
      meta: { row_id: newRowId, nombre, attempts },
    });
    log.info("AppSheet Add ok", {
      tecnico_id: row.tecnico_id,
      row_id: newRowId,
      nombre,
    });
    return {
      tecnico_id: row.tecnico_id,
      action: "added",
      appsheet_row_id: newRowId,
      attempts,
    };
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    await markFailure(deps, row.tecnico_id, errMsg, attempts, threshold);
    return {
      tecnico_id: row.tecnico_id,
      action: "skipped",
      attempts,
      error: errMsg,
    };
  }
}

// ---------------------------------------------------------------------------
// Delete path
// ---------------------------------------------------------------------------

async function processDelete(
  deps: ProjectorTickDeps,
  row: CandidateRow,
  attempts: number,
  threshold: number
): Promise<ProjectorTickResult> {
  if (!row.appsheet_row_id) {
    // Nothing to delete; clear the flag so we don't loop on this forever.
    await deps.supa
      .from("tecnicos_extended")
      .update({
        appsheet_delete_pending: false,
        appsheet_sync_last_error: null,
      })
      .eq("tecnico_id", row.tecnico_id);
    await deps.supa.from("eventos").insert({
      type: "appsheet_deleted",
      entity_id: row.tecnico_id,
      actor: "system:projector",
      meta: { row_id: null, no_row_id: true, attempts },
    });
    return {
      tecnico_id: row.tecnico_id,
      action: "skipped_already_gone",
      attempts,
    };
  }
  try {
    const { alreadyGone } = await deps.appsheet.deleteTecnico(
      row.appsheet_row_id
    );
    await deps.supa
      .from("tecnicos_extended")
      .update({
        appsheet_delete_pending: false,
        appsheet_sync_last_error: null,
        // appsheet_row_id stays for forever-audit per §8.3.
      })
      .eq("tecnico_id", row.tecnico_id);
    await deps.supa.from("eventos").insert({
      type: "appsheet_deleted",
      entity_id: row.tecnico_id,
      actor: "system:projector",
      meta: {
        row_id: row.appsheet_row_id,
        already_gone: alreadyGone,
        attempts,
      },
    });
    log.info("AppSheet Delete ok", {
      tecnico_id: row.tecnico_id,
      row_id: row.appsheet_row_id,
      already_gone: alreadyGone,
    });
    return {
      tecnico_id: row.tecnico_id,
      action: "deleted",
      attempts,
    };
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    await markFailure(deps, row.tecnico_id, errMsg, attempts, threshold);
    return {
      tecnico_id: row.tecnico_id,
      action: "skipped",
      attempts,
      error: errMsg,
    };
  }
}

// ---------------------------------------------------------------------------
// Failure plumbing
// ---------------------------------------------------------------------------

async function markFailure(
  deps: ProjectorTickDeps,
  tecnicoId: string,
  errorMsg: string,
  attempts: number,
  threshold: number
): Promise<void> {
  await deps.supa
    .from("tecnicos_extended")
    .update({ appsheet_sync_last_error: errorMsg.slice(0, 500) })
    .eq("tecnico_id", tecnicoId);
  await deps.supa.from("eventos").insert({
    type: "appsheet_projection_failed",
    entity_id: tecnicoId,
    actor: "system:projector",
    meta: { error: errorMsg.slice(0, 500), attempts },
  });
  if (attempts >= threshold) {
    await deps.telegram?.send(
      `AppSheet projection failed ${attempts}x for ${tecnicoId}: ${errorMsg.slice(0, 300)}`
    );
  }
}

function extractString(meta: unknown, key: string): string | null {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return null;
  const v = (meta as Record<string, unknown>)[key];
  return typeof v === "string" && v.trim().length > 0 ? v : null;
}
