// Tools index — import these wherever the 9-tool contract is needed.

export * from "./types";
export * from "./context";
export * from "./schemas";
export { recordEvent, logLlmCall, logLlmError } from "./events";
export type { RecordEventInput, LlmCallMeta, LlmErrorMeta } from "./events";
export { identifyUser } from "./identify-user";
export { registerTecnico } from "./register-tecnico";
export { readPendingOts } from "./read-pending-ots";
export { createPostulacion } from "./create-postulacion";
export { readMyPostulaciones } from "./read-my-postulaciones";
export { readMyContratos } from "./read-my-contratos";
export { uploadDocumento } from "./upload-documento";
export { escalateToHr } from "./escalate-to-hr";
export { logEvent } from "./log-event";

// Centralized dispatcher — used by Toño and by the dashboard chat API route.
import type { ToolContext } from "./context";
import { identifyUser } from "./identify-user";
import { registerTecnico } from "./register-tecnico";
import { readPendingOts } from "./read-pending-ots";
import { createPostulacion } from "./create-postulacion";
import { readMyPostulaciones } from "./read-my-postulaciones";
import { readMyContratos } from "./read-my-contratos";
import { uploadDocumento } from "./upload-documento";
import { escalateToHr } from "./escalate-to-hr";
import { logEvent } from "./log-event";
import type { ToolName } from "./schemas";
import type { ToolResult } from "./types";

export type ToolArgs = Record<string, unknown>;

export async function dispatchTool(
  ctx: ToolContext,
  name: ToolName | string,
  // LLM-provided args — we cast to each tool's input type internally.
  // Keep as unknown at the boundary; trust NO field.
  args: ToolArgs
): Promise<ToolResult<unknown>> {
  switch (name) {
    case "identify_user":
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- LLM payload is unknown at boundary
      return identifyUser(ctx, args as any);
    case "register_tecnico":
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return registerTecnico(ctx, args as any);
    case "read_pending_ots":
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return readPendingOts(ctx, args as any);
    case "create_postulacion":
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return createPostulacion(ctx, args as any);
    case "read_my_postulaciones":
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return readMyPostulaciones(ctx, args as any);
    case "read_my_contratos":
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return readMyContratos(ctx, args as any);
    case "upload_documento":
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return uploadDocumento(ctx, args as any);
    case "escalate_to_hr":
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return escalateToHr(ctx, args as any);
    case "log_event":
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return logEvent(ctx, args as any);
    default:
      return {
        ok: false,
        error: `unknown tool: ${name}`,
        code: "unknown_tool",
      };
  }
}
