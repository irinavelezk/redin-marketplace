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

  // Enrich with name from tecnicos_mirror so the agent can greet by name
  // rather than echoing the internal tecnico_id.
  const { data: mirror } = await ctx.supabase
    .from("tecnicos_mirror")
    .select("data")
    .eq("row_id", data.tecnico_id)
    .maybeSingle();

  let nombre: string | null = null;
  if (mirror?.data && typeof mirror.data === "object" && !Array.isArray(mirror.data)) {
    const m = mirror.data as Record<string, unknown>;
    const n = m["Nombre"] ?? m["nombre"] ?? m["NOMBRE"];
    if (typeof n === "string" && n.trim().length > 0) nombre = n.trim();
  }

  return ok({ found: true, tecnico: { ...data, nombre } });
}
