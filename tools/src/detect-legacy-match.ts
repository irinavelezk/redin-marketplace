// Detect a possible legacy-worker match by fuzzy name comparison.
//
// Used as a SOFT signal — not a gate. Per policy 2026-05-16, we never block
// the screening flow or escalate based on a name match alone. We just record
// the matches against the new worker's row so HR can decide on the
// qualification queue whether to merge the new submission into the legacy
// bootstrap row or treat it as net-new.
//
// Pure read. Safe to call from any tool. Excludes the caller's own
// tecnico_id from the candidate pool so a legacy worker enriching their own
// row (CASE A) never self-matches.

import type { ServerClient } from "@redin/shared";
import { findMatches, type NameMatch } from "./legacy-name-match";

export async function detectLegacyMatches(
  supabase: ServerClient,
  name: string,
  excludeTecnicoId?: string
): Promise<NameMatch[]> {
  const trimmed = (name ?? "").trim();
  if (trimmed.length < 2) return [];

  const { data: rows, error: rowsErr } = await supabase
    .from("tecnicos_extended")
    .select("tecnico_id")
    .eq("candidate_state", "approved")
    .eq("profile_complete", false)
    .eq("import_source", "appsheet_legacy_bootstrap");
  if (rowsErr || !rows || rows.length === 0) return [];

  const tecnicoIds = rows
    .map((r) => r.tecnico_id)
    .filter((id): id is string => !!id && id !== excludeTecnicoId);
  if (tecnicoIds.length === 0) return [];

  const { data: events, error: evErr } = await supabase
    .from("eventos")
    .select("entity_id, meta")
    .eq("type", "tecnico_legacy_bootstrap")
    .in("entity_id", tecnicoIds);
  if (evErr) return [];

  const candidates: { tecnico_id: string; nombre: string }[] = [];
  for (const ev of events ?? []) {
    if (!ev.entity_id) continue;
    const m = ev.meta as Record<string, unknown> | null;
    const n = m && typeof m === "object" ? m["nombre"] : null;
    if (typeof n === "string" && n.trim().length > 0) {
      candidates.push({ tecnico_id: ev.entity_id, nombre: n.trim() });
    }
  }

  return findMatches(trimmed, candidates);
}
