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

  // Enrich profile so the agent has nombre/ciudad/especialidades/modalidad to
  // greet, filter jobs, and avoid hallucinating "no tengo tus datos". Two sources:
  //   1) `tecnico_registered` event meta — when the worker registered through
  //      Toño (source="dashboard" / "whatsapp"); has the full profile.
  //   2) `tecnicos_mirror.data` — when the row came from the AppSheet sync;
  //      currently only nombre is reliably exposed.
  let nombre: string | null = null;
  let ciudad: string | null = null;
  let especialidades: string[] | null = null;
  let modalidad: string | null = null;

  const { data: regEvent } = await ctx.supabase
    .from("eventos")
    .select("meta")
    .eq("type", "tecnico_registered")
    .eq("entity_id", data.tecnico_id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (regEvent?.meta && typeof regEvent.meta === "object" && !Array.isArray(regEvent.meta)) {
    const m = regEvent.meta as Record<string, unknown>;
    if (typeof m.nombre === "string" && m.nombre.trim().length > 0) nombre = m.nombre.trim();
    if (typeof m.ciudad === "string" && m.ciudad.trim().length > 0) ciudad = m.ciudad.trim();
    if (Array.isArray(m.especialidades)) {
      const esp = m.especialidades.filter(
        (e): e is string => typeof e === "string" && e.trim().length > 0
      );
      if (esp.length > 0) especialidades = esp;
    }
    if (typeof m.modalidad === "string" && m.modalidad.trim().length > 0) {
      modalidad = m.modalidad.trim();
    }
  }

  if (!nombre) {
    const { data: mirror } = await ctx.supabase
      .from("tecnicos_mirror")
      .select("data")
      .eq("row_id", data.tecnico_id)
      .maybeSingle();
    if (mirror?.data && typeof mirror.data === "object" && !Array.isArray(mirror.data)) {
      const m = mirror.data as Record<string, unknown>;
      const n = m["Nombre"] ?? m["nombre"] ?? m["NOMBRE"];
      if (typeof n === "string" && n.trim().length > 0) nombre = n.trim();
    }
  }

  return ok({
    found: true,
    tecnico: { ...data, nombre, ciudad, especialidades, modalidad },
  });
}
