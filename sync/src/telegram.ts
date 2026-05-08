// Minimal Telegram sink for sync-side escalations (projector failures).
// Pattern lifted from tono/src/telegram-escalation.ts. If either env var is
// missing, send() returns false but does NOT throw — the projector still
// functions, just without HR pings.

import { createLogger } from "@redin/shared";

const log = createLogger("sync:telegram");

export interface TelegramSink {
  send(text: string): Promise<{ delivered: boolean }>;
}

export class TelegramBotSink implements TelegramSink {
  constructor(
    private botToken: string | undefined,
    private hrChatId: string | undefined
  ) {}

  static fromEnv(): TelegramBotSink {
    return new TelegramBotSink(
      process.env.TELEGRAM_BOT_TOKEN,
      process.env.HR_TELEGRAM_CHAT_ID
    );
  }

  async send(text: string): Promise<{ delivered: boolean }> {
    if (!this.botToken || !this.hrChatId) {
      log.warn("telegram sink not configured; message logged only", {
        text: text.slice(0, 200),
        has_token: !!this.botToken,
        has_chat: !!this.hrChatId,
      });
      return { delivered: false };
    }
    try {
      const res = await fetch(
        `https://api.telegram.org/bot${this.botToken}/sendMessage`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: this.hrChatId,
            text: text.slice(0, 4000),
          }),
        }
      );
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        log.warn("telegram send non-2xx", {
          status: res.status,
          body: body.slice(0, 200),
        });
        return { delivered: false };
      }
      return { delivered: true };
    } catch (e) {
      log.warn("telegram send threw", {
        error: e instanceof Error ? e.message : String(e),
      });
      return { delivered: false };
    }
  }
}
