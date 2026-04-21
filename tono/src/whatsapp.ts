// Baileys WhatsApp wrapper — handles multi-file auth, QR pairing, reconnect,
// and emits inbound text messages through a handler callback. Concurrency is
// handled by the caller (KeyedMutex); this file just bridges to Baileys.
//
// On pair: we print the QR in the terminal. On success Baileys writes creds
// to the auth dir. Reconnects on non-logout disconnects.

import { Boom } from "@hapi/boom";
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  type WASocket,
  type ConnectionState,
  type WAMessage,
} from "@whiskeysockets/baileys";
import qrcode from "qrcode-terminal";
import { createLogger, phoneFromJid } from "@redin/shared";
import pino from "pino";
import path from "node:path";
import fs from "node:fs";

const log = createLogger("tono:wa");

export interface WhatsAppHandlers {
  onMessage: (ev: { phone: string; text: string; jid: string }) => Promise<void>;
  onReady?: () => void | Promise<void>;
}

export interface WhatsAppOptions {
  authDir: string;
  handlers: WhatsAppHandlers;
  // If true, print QR to stdout. False in prod (we pair once, creds persist).
  printQr?: boolean;
}

export class WhatsAppClient {
  private sock: WASocket | null = null;
  private reconnecting = false;

  constructor(private opts: WhatsAppOptions) {
    fs.mkdirSync(opts.authDir, { recursive: true });
  }

  async start(): Promise<void> {
    const { state, saveCreds } = await useMultiFileAuthState(this.opts.authDir);
    // Silence Baileys' internal logger — we have our own structured logger.
    const silentLogger = pino({ level: "silent" });
    this.sock = makeWASocket({
      auth: state,
      printQRInTerminal: false, // we handle QR ourselves
      logger: silentLogger as unknown as pino.Logger,
      // mobile=false → standard multi-device (QR scan pairing)
      browser: ["Toño Redin", "Chrome", "1.0"],
      // syncFullHistory false — we only care about new messages
      syncFullHistory: false,
      markOnlineOnConnect: true,
    });

    this.sock.ev.on("creds.update", saveCreds);
    this.sock.ev.on("connection.update", (u) => this.onConnectionUpdate(u));
    this.sock.ev.on("messages.upsert", async (m) => {
      if (m.type !== "notify" && m.type !== "append") return;
      for (const msg of m.messages) {
        await this.handleIncoming(msg).catch((e) => {
          log.error("handle incoming failed", { error: e instanceof Error ? e.message : String(e) });
        });
      }
    });
  }

  async stop(): Promise<void> {
    if (this.sock) {
      try {
        await this.sock.logout();
      } catch {
        /* ignore */
      }
      this.sock = null;
    }
  }

  async sendText(jid: string, text: string): Promise<void> {
    if (!this.sock) throw new Error("socket not ready");
    const chunks = chunkText(text, 3500);
    for (const c of chunks) {
      await this.sock.sendMessage(jid, { text: c });
    }
  }

  private onConnectionUpdate(u: Partial<ConnectionState>): void {
    const { connection, lastDisconnect, qr } = u;
    if (qr && this.opts.printQr !== false) {
      log.info("QR code received — scan with the Toño WhatsApp number (printing to terminal)");
      qrcode.generate(qr, { small: true });
    }
    if (connection === "open") {
      log.info("connected to WhatsApp", { authDir: this.opts.authDir });
      this.opts.handlers.onReady?.();
    }
    if (connection === "close") {
      const statusCode = (lastDisconnect?.error as Boom | undefined)?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;
      log.warn("disconnected", { statusCode, loggedOut });
      if (!loggedOut && !this.reconnecting) {
        this.reconnecting = true;
        setTimeout(() => {
          this.reconnecting = false;
          this.start().catch((e) =>
            log.error("reconnect failed", { error: e instanceof Error ? e.message : String(e) })
          );
        }, 2000);
      }
      if (loggedOut) {
        log.error(
          "logged out — delete the auth dir and re-pair with `npm run tono:pair`",
          { authDir: this.opts.authDir }
        );
      }
    }
  }

  private async handleIncoming(msg: WAMessage): Promise<void> {
    if (msg.key.fromMe) return;
    if (!msg.message) return;
    // Only handle text and extended text (captioned messages etc. out of scope for v1).
    const jid = msg.key.remoteJid ?? "";
    if (!jid || jid.endsWith("@g.us")) return; // skip groups in v1
    const text =
      msg.message.conversation ??
      msg.message.extendedTextMessage?.text ??
      "";
    if (!text.trim()) return;
    const phone = phoneFromJid(jid);
    if (!phone) return;
    await this.opts.handlers.onMessage({ phone, text, jid });
  }
}

function chunkText(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    let cut = remaining.lastIndexOf("\n", limit);
    if (cut <= 0 || cut > limit) cut = Math.min(limit, remaining.length);
    chunks.push(remaining.substring(0, cut));
    remaining = remaining.substring(cut).trimStart();
  }
  return chunks;
}

// Canonical auth dir for the Toño session. Railway volume mounts to /data in prod;
// locally it lives under the marketplace data/ dir (gitignored).
export function defaultAuthDir(): string {
  const base = process.env.TONO_DATA_DIR || path.resolve(process.cwd(), "..", "data");
  return path.join(base, "tono-wa-auth");
}
