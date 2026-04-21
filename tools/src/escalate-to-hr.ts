// escalate_to_hr — writes an escalation event and hands it to the optional
// escalation sink (Telegram). If the sink fails, the event is still recorded.
// Toño / the dashboard must call this whenever confidence is low or the user
// explicitly asks for a human.

import type { ToolContext } from "./context";
import { recordEvent } from "./events";
import type {
  EscalateToHrInput,
  EscalateToHrOutput,
  ToolResult,
} from "./types";
import { err, ok } from "./types";

export async function escalateToHr(
  ctx: ToolContext,
  input: EscalateToHrInput
): Promise<ToolResult<EscalateToHrOutput>> {
  if (!input.reason?.trim()) return err("reason required", { code: "invalid_input" });
  if (!input.context?.trim()) return err("context required", { code: "invalid_input" });

  const { id: escalationId } = await recordEvent(ctx, {
    type: "escalation",
    entity_id: input.tecnico_id ?? null,
    actor: input.actor ?? ctx.defaultActor,
    meta: {
      reason: input.reason,
      context: input.context,
      phone: input.phone ?? null,
    },
  });

  let delivered = false;
  if (ctx.escalationSink) {
    try {
      const res = await ctx.escalationSink.notify({
        escalation_id: escalationId,
        reason: input.reason,
        context: input.context,
        tecnico_id: input.tecnico_id ?? null,
        phone: input.phone ?? null,
      });
      delivered = res.delivered;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      ctx.logger.error("escalation sink failed", {
        escalation_id: escalationId,
        error: msg,
      });
      // Not fatal — eventos row is the source of truth.
    }
  }

  return ok({ escalation_id: escalationId, delivered_to_telegram: delivered });
}
