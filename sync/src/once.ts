// Run exactly one refreshAll and exit. Used for: scripts, first-boot, manual kick.

import { createLogger, requireEnv } from "@redin/shared";
import { AppSheetReadClient } from "./appsheet";
import { SyncWorker } from "./mirror";

const log = createLogger("sync:once");

async function main() {
  const appsheet = new AppSheetReadClient({
    appId: requireEnv("APPSHEET_APP_ID"),
    accessKey: requireEnv("APPSHEET_ACCESS_KEY"),
  });
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
