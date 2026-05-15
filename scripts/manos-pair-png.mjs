// One-off Manos WA pair that renders the QR as a PNG and opens it in macOS Preview.
// Uses Baileys directly + qrcode package. Saves creds to data/manos-wa-auth/ on success.

import { makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason } from "@whiskeysockets/baileys";
import QRCode from "qrcode";
import { exec } from "node:child_process";
import path from "node:path";
import fs from "node:fs";

const AUTH_DIR = path.resolve("data/manos-wa-auth");
const PNG_PATH = "/tmp/manos-qr.png";

fs.mkdirSync(AUTH_DIR, { recursive: true });

const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
const { version } = await fetchLatestBaileysVersion();
console.log(`Baileys version ${version.join(".")} — auth dir ${AUTH_DIR}`);

const sock = makeWASocket({
  version,
  auth: state,
  printQRInTerminal: false,
  syncFullHistory: false,
});

sock.ev.on("creds.update", saveCreds);

let lastQrTs = 0;
sock.ev.on("connection.update", async (u) => {
  const { connection, qr, lastDisconnect } = u;

  if (qr) {
    const now = Date.now();
    if (now - lastQrTs < 2000) return; // dedupe rapid refreshes
    lastQrTs = now;
    await QRCode.toFile(PNG_PATH, qr, { width: 600, margin: 2 });
    console.log(`\n=== QR rendered to ${PNG_PATH} (refreshed at ${new Date(now).toISOString()}) ===`);
    console.log("Opening in Preview…");
    exec(`open "${PNG_PATH}"`);
    console.log("Scan with the Manos phone: WhatsApp → Settings → Linked Devices → Link a Device.\n");
  }

  if (connection === "open") {
    console.log("\n✓ Paired successfully. Creds saved to", AUTH_DIR);
    console.log("Closing socket…");
    setTimeout(() => process.exit(0), 1000);
  }

  if (connection === "close") {
    const reason = lastDisconnect?.error?.output?.statusCode;
    if (reason === DisconnectReason.loggedOut) {
      console.log("Logged out. Exiting.");
      process.exit(1);
    }
    // 408/restartRequired/etc — normal during initial connect; Baileys auto-reconnects
    console.log(`(transient disconnect ${reason ?? "?"} — waiting for next QR)`);
  }
});
