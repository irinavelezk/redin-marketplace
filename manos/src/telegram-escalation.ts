// Minimal Telegram escalation sink for Manos.
// Posts to HR_TELEGRAM_CHAT_ID via bot token.
// If either env var is missing, send() returns silently.

import { createLogger } from "@redin/shared";
import type { EscalationSink } from "@redin/tools";

const log = createLogger("manos:tg-escalation");

export class TelegramEscalationSink implements EscalationSink {
  constructor(
    private botToken: string | undefined,
    private hrChatId: string | undefined
  ) {}

  static fromEnv(): TelegramEscalationSink {
    return new TelegramEscalationSink(
      process.env.TELEGRAM_BOT_TOKEN,
      process.env.HR_TELEGRAM_CHAT_ID
    );
  }

  /** Send a freeform text message to HR. Used by cédula gate and other alerts. */
  async send(text: string): Promise<void> {
    if (!this.botToken || !this.hrChatId) {
      log.warn("telegram sink not configured; message dropped", {
        has_token: !!this.botToken,
        has_chat: !!this.hrChatId,
      });
      return;
    }
    try {
      const res = await fetch(`https://api.telegram.org/bot${this.botToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: this.hrChatId, text: text.slice(0, 4096) }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        log.error("telegram send failed", { status: res.status, body: body.slice(0, 200) });
      }
    } catch (e) {
      log.error("telegram send threw", { error: e instanceof Error ? e.message : String(e) });
    }
  }

  /** EscalationSink compatibility (used by @redin/tools). */
  async notify(payload: {
    escalation_id: string;
    reason: string;
    context: string;
    tecnico_id?: string | null;
    phone?: string | null;
  }): Promise<{ delivered: boolean }> {
    if (!this.botToken || !this.hrChatId) return { delivered: false };
    const body = [
      "🚨 Escalación de Manos",
      "",
      `Razón: ${payload.reason}`,
      `Arquitecto phone: ${payload.phone ?? "(sin phone)"}`,
      "",
      "Contexto:",
      payload.context.slice(0, 3500),
      "",
      `esc_id: ${payload.escalation_id}`,
    ].join("\n");
    try {
      const res = await fetch(`https://api.telegram.org/bot${this.botToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: this.hrChatId, text: body }),
      });
      return { delivered: res.ok };
    } catch {
      return { delivered: false };
    }
  }
}
