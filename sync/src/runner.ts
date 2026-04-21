// Long-running sync service: runs refreshAll() every 15 minutes + exposes a simple
// signal handler so you can trigger on-demand refresh via SIGUSR1 (useful for dev).

import cron from "node-cron";
import { createLogger, requireEnv } from "@redin/shared";
import { AppSheetReadClient } from "./appsheet";
import { SyncWorker } from "./mirror";

const log = createLogger("sync:runner");

async function main() {
  const appsheet = new AppSheetReadClient({
    appId: requireEnv("APPSHEET_APP_ID"),
    accessKey: requireEnv("APPSHEET_ACCESS_KEY"),
  });
  const worker = new SyncWorker({ appsheet });

  log.info("starting sync runner", {
    cron: "*/15 * * * *",
    timezone: "America/Bogota",
  });

  // Initial refresh so the system doesn't wait 15 min on cold boot.
  worker.refreshAll().catch((e) => log.error("initial refresh failed", { error: String(e) }));

  cron.schedule(
    "*/15 * * * *",
    async () => {
      try {
        const r = await worker.refreshAll();
        log.info("cron refresh ok", { ok: r.ok, total_ms: r.total_ms });
      } catch (e) {
        log.error("cron refresh failed", { error: e instanceof Error ? e.message : String(e) });
      }
    },
    { timezone: "America/Bogota" }
  );

  process.on("SIGUSR1", () => {
    log.info("on-demand refresh signaled");
    worker.refreshAll().catch((e) =>
      log.error("on-demand refresh failed", { error: String(e) })
    );
  });

  // Keep the process alive (node-cron holds an interval; we also add an idle keep-alive).
  setInterval(() => {
    /* heartbeat */
  }, 60_000);
}

main().catch((e) => {
  log.error("runner fatal", { error: e instanceof Error ? e.message : String(e) });
  process.exit(1);
});
