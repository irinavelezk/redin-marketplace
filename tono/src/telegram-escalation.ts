// Minimal Telegram escalation sink. Posts to HR_TELEGRAM_CHAT_ID via bot token.
// If either env var is missing, notify() returns delivered:false. The event row
// is still written by escalate_to_hr.
//
// Reuses the same bot token as the v1 architect bot by default (TELEGRAM_BOT_TOKEN).
// HR_TELEGRAM_CHAT_ID must be set to the HR person's chat id.

import { createLogger } from "@redin/shared";
import type { EscalationSink } from "@redin/tools";

const log = createLogger("tono:tg-escalation");

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

  async notify(payload: {
    escalation_id: string;
    reason: string;
    context: string;
    tecnico_id?: string | null;
    phone?: string | null;
  }): Promise<{ delivered: boolean }> {
    if (!this.botToken || !this.hrChatId) {
      log.warn("telegram sink not configured; escalation logged only", {
        escalation_id: payload.escalation_id,
        has_token: !!this.botToken,
        has_chat: !!this.hrChatId,
      });
      return { delivered: false };
    }
    const body = [
      "🚨 Escalación de Toño",
      "",
      `Razón: ${payload.reason}`,
      `Técnico: ${payload.tecnico_id ?? "(sin id)"} — ${payload.phone ?? "(sin phone)"}`,
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
        body: JSON.stringify({
          chat_id: this.hrChatId,
          text: body,
        }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        log.error("telegram send failed", { status: res.status, body: text.slice(0, 200) });
        return { delivered: false };
      }
      return { delivered: true };
    } catch (e) {
      log.error("telegram send threw", { error: e instanceof Error ? e.message : String(e) });
      return { delivered: false };
    }
  }
}
