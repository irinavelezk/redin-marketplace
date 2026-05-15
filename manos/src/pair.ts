// Pair-only mode: starts Baileys just long enough to show the QR and save creds.
// Once connection opens, we exit. Use `npm run manos:pair` once per number.

import { createLogger, createServerClient } from "@redin/shared";
import { WhatsAppClient, defaultAuthDir } from "./whatsapp";

const log = createLogger("manos:pair");

async function main() {
  const supabase = createServerClient();
  const wa = new WhatsAppClient({
    authDir: defaultAuthDir(),
    supabase,
    printQr: true,
    handlers: {
      onMessage: async () => {
        // ignore messages during pairing
      },
      onReady: () => {
        log.info("Paired successfully. Creds saved. You can now run `npm run manos:dev`.");
        setTimeout(() => process.exit(0), 500);
      },
    },
  });
  await wa.start();
  log.info("Waiting for QR scan…");
  log.info(`Auth dir: ${defaultAuthDir()}`);
}

main().catch((e) => {
  log.error("pair failed", { error: e instanceof Error ? e.message : String(e) });
  process.exit(1);
});
