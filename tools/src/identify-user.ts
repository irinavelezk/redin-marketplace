// identify_user — look up a técnico by phone. First step of every session.

import { normalizePhone } from "@redin/shared";
import type { ToolContext } from "./context";
import type { IdentifyUserInput, IdentifyUserOutput, ToolResult } from "./types";
import { err, ok } from "./types";

export async function identifyUser(
  ctx: ToolContext,
  input: IdentifyUserInput
): Promise<ToolResult<IdentifyUserOutput>> {
  const phone = normalizePhone(input.phone);
  if (!phone) return err("phone is required", { code: "invalid_input" });

  const { data, error } = await ctx.supabase
    .from("tecnicos_extended")
    .select("*")
    .eq("phone", phone)
    .maybeSingle();

  if (error) {
    ctx.logger.error("identify_user failed", { phone, error: error.message });
    return err(`db error: ${error.message}`, { code: "db_error", retryable: true });
  }

  if (!data) return ok({ found: false, phone });
  return ok({ found: true, tecnico: data });
}
