// Run exactly one sync action and exit. Two modes:
//   default:           refreshAll (mirror).
//   --projector-only:  one projector tick (drains pending Add/Delete).

import { createLogger, createServerClient, requireEnv } from "@redin/shared";
import { AppSheetReadClient } from "./appsheet";
import { SyncWorker } from "./mirror";
import { tickOnce } from "./projector";
import { TelegramBotSink } from "./telegram";

const log = createLogger("sync:once");

async function main() {
  const projectorOnly = process.argv.includes("--projector-only");

  const appsheet = new AppSheetReadClient({
    appId: requireEnv("APPSHEET_APP_ID"),
    accessKey: requireEnv("APPSHEET_ACCESS_KEY"),
  });

  if (projectorOnly) {
    const supa = createServerClient();
    const telegram = TelegramBotSink.fromEnv();
    const results = await tickOnce({ supa, appsheet, telegram });
    log.info("projector tick complete", { count: results.length });
    for (const r of results) {
      log.info(`  ${r.tecnico_id}`, {
        action: r.action,
        attempts: r.attempts,
        appsheet_row_id: r.appsheet_row_id,
        error: r.error,
      });
    }
    process.exit(0);
  }

  const worker = new SyncWorker({ appsheet });
  const r = await worker.refreshAll();
  log.info("refresh complete", { ok: r.ok, total_ms: r.total_ms });
  for (const pt of r.per_table) {
    log.info(`  ${pt.table}`, {
      rows_seen: pt.rows_seen,
      rows_upserted: pt.rows_upserted,
      duration_ms: pt.duration_ms,
      error: pt.error,
    });
  }
  process.exit(r.ok ? 0 : 1);
}

main().catch((e) => {
  log.error("once fatal", { error: e instanceof Error ? e.message : String(e) });
  process.exit(1);
});
