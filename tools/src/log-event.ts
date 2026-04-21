// log_event — thin public wrapper around recordEvent, exposed to the agent
// for free-form observations (e.g. "user frustrated", "clarification asked").

import type { ToolContext } from "./context";
import { recordEvent } from "./events";
import type { LogEventInput, LogEventOutput, ToolResult } from "./types";
import { err, ok } from "./types";

export async function logEvent(
  ctx: ToolContext,
  input: LogEventInput
): Promise<ToolResult<LogEventOutput>> {
  if (!input.type?.trim()) return err("type required", { code: "invalid_input" });
  const { id } = await recordEvent(ctx, {
    type: input.type,
    entity_id: input.entity_id ?? null,
    actor: input.actor ?? ctx.defaultActor,
    meta: input.meta ?? {},
  });
  return ok({ evento_id: id });
}
