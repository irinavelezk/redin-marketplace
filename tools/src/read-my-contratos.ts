// read_my_contratos — all contratos belonging to a tecnico_id.

import type { ToolContext } from "./context";
import type {
  ReadMyContratosInput,
  ReadMyContratosOutput,
  ToolResult,
} from "./types";
import { err, ok } from "./types";

export async function readMyContratos(
  ctx: ToolContext,
  input: ReadMyContratosInput
): Promise<ToolResult<ReadMyContratosOutput>> {
  if (!input.tecnico_id?.trim()) {
    return err("tecnico_id required", { code: "invalid_input" });
  }
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);

  const { data, error } = await ctx.supabase
    .from("contratos")
    .select("*")
    .eq("tecnico_id", input.tecnico_id)
    .order("sent_at", { ascending: false, nullsFirst: false })
    .limit(limit);
  if (error) {
    return err(`db error: ${error.message}`, { code: "db_error", retryable: true });
  }
  return ok({ contratos: data ?? [] });
}
