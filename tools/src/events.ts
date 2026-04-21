// Single helper every tool uses to write to `eventos`.
// If this fails, the tool must fail visibly — HITL measurement depends on this log.

import type { Json } from "@redin/shared";
import type { ToolContext } from "./context";
import type { Actor } from "./types";

export interface RecordEventInput {
  type: string;
  entity_id?: string | null;
  actor?: Actor;
  meta?: Record<string, unknown>;
}

export async function recordEvent(
  ctx: ToolContext,
  input: RecordEventInput
): Promise<{ id: string }> {
  const actor = input.actor ?? ctx.defaultActor;
  const { data, error } = await ctx.supabase
    .from("eventos")
    .insert({
      type: input.type,
      entity_id: input.entity_id ?? null,
      actor,
      meta: (input.meta ?? {}) as Json,
    })
    .select("id")
    .single();
  if (error) {
    ctx.logger.error("eventos insert failed", {
      type: input.type,
      entity_id: input.entity_id,
      error: error.message,
    });
    throw new Error(`eventos insert failed: ${error.message}`);
  }
  return { id: data.id };
}
