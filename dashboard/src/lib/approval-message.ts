// Compose the proactive WhatsApp body sent to a worker the moment HR
// approves them. Instead of a static "you can apply now, ask me about
// jobs", we look up offerable OTs in their ciudad that match their
// declared skills and surface up to 3 inline so the worker can engage
// immediately. If profile data is missing or the lookup throws, the
// caller falls back to the legacy static message — never blocks approval.
//
// The matching rules are intentionally simple (substring + accent-strip,
// city + any skill overlap). When a future OT-coordinator agent takes
// over autonomous offering, this helper retires.

import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { OFFERABLE_ESTADO } from "@redin/tools/read-pending-ots";
import { otDescripcion, otValorEstimado } from "@/lib/ot-display";

const MAX_OTS_IN_MESSAGE = 3;
const MAX_DESC_LEN = 80;

function normalize(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

function firstName(full: string | null | undefined): string | null {
  if (!full) return null;
  const cleaned = full.trim().split(/\s+/)[0];
  return cleaned || null;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trimEnd() + "…";
}

interface ProfileSnapshot {
  nombre: string | null;
  ciudad: string | null;
  skills: string[]; // categorias ∪ subcategorias
}

async function loadProfile(
  supa: SupabaseClient,
  tecnicoId: string
): Promise<ProfileSnapshot> {
  const [tecRes, regRes, dossierRes] = await Promise.all([
    supa
      .from("tecnicos_extended")
      .select("nombre")
      .eq("tecnico_id", tecnicoId)
      .maybeSingle(),
    supa
      .from("eventos")
      .select("meta")
      .eq("type", "tecnico_registered")
      .eq("entity_id", tecnicoId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    supa
      .from("candidate_dossiers")
      .select("payload")
      .eq("tecnico_id", tecnicoId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  const nombre =
    (tecRes.data?.nombre as string | null | undefined) ?? null;

  const meta = regRes.data?.meta as Record<string, unknown> | null | undefined;
  const ciudad =
    meta && typeof meta.ciudad === "string" ? (meta.ciudad as string) : null;

  const payload = dossierRes.data?.payload as
    | Record<string, unknown>
    | null
    | undefined;
  const cats =
    payload && Array.isArray(payload.categorias_principales)
      ? (payload.categorias_principales as unknown[]).filter(
          (x): x is string => typeof x === "string"
        )
      : [];
  const subs =
    payload && Array.isArray(payload.subcategorias)
      ? (payload.subcategorias as unknown[]).filter(
          (x): x is string => typeof x === "string"
        )
      : [];

  return { nombre, ciudad, skills: [...cats, ...subs] };
}

function skillMatches(
  otEspecialidad: string | null,
  skills: string[]
): boolean {
  if (skills.length === 0) return true; // no declared skills → don't filter
  if (!otEspecialidad) return false;
  const e = normalize(otEspecialidad);
  return skills.some((s) => {
    const n = normalize(s);
    return e.includes(n) || n.includes(e);
  });
}

export async function composeApprovalMessage(
  supa: SupabaseClient,
  tecnicoId: string,
  fallback: string
): Promise<string> {
  let profile: ProfileSnapshot;
  try {
    profile = await loadProfile(supa, tecnicoId);
  } catch (e) {
    console.warn("composeApprovalMessage profile load failed", {
      tecnicoId,
      error: e instanceof Error ? e.message : String(e),
    });
    return fallback;
  }

  const greeting = profile.nombre
    ? `Listo, ${firstName(profile.nombre)}`
    : "Listo";

  // Without a ciudad we can't match meaningfully. Personalize the greeting
  // but keep the rest of the legacy message.
  if (!profile.ciudad) {
    return `${greeting} — ${fallback.replace(/^Listo[^—]*— /, "")}`;
  }

  let candidateOts: Array<{
    row_id: string;
    ciudad: string | null;
    especialidad: string | null;
    data: unknown;
  }> = [];
  try {
    const { data } = await supa
      .from("ots_mirror")
      .select("row_id, ciudad, especialidad, data")
      .eq("estado", OFFERABLE_ESTADO);
    candidateOts = data ?? [];
  } catch (e) {
    console.warn("composeApprovalMessage OTs query failed", {
      tecnicoId,
      error: e instanceof Error ? e.message : String(e),
    });
    return `${greeting} — ${fallback.replace(/^Listo[^—]*— /, "")}`;
  }

  // Match by ciudad ONLY — same filter the agent's read_pending_ots tool
  // uses, so the proactive message can't contradict what the agent says
  // a turn later when the worker asks "what's available?". Skill match
  // is reported per-OT as a small disclaimer ("no es exactamente tu
  // especialidad") rather than used as a filter that hides jobs.
  //
  // Earlier version filtered out skill-mismatched OTs entirely, which led
  // to the proactive message saying "no tengo trabajos en Valledupar para
  // tu especialidad" followed seconds later by the agent volunteering
  // "Hay uno: limpieza de fachada" — same OT, same ciudad, contradictory
  // claim. Now both paths show the same set.
  const ciudadNorm = normalize(profile.ciudad);
  const matches = candidateOts
    .filter((o) => {
      if (!o.ciudad) return false;
      return normalize(o.ciudad).includes(ciudadNorm);
    })
    .slice(0, MAX_OTS_IN_MESSAGE);

  if (matches.length === 0) {
    return `${greeting} — tu perfil quedó aprobado. Por ahora no tengo trabajos abiertos en ${profile.ciudad}, pero apenas entre algo te aviso.`;
  }

  const declaredSkills = profile.skills.length > 0;
  const lines = matches.map((o) => {
    const desc = truncate(
      otDescripcion(o.data) || "(sin descripción)",
      MAX_DESC_LEN
    );
    const valor = otValorEstimado(o.data);
    const skillNote =
      declaredSkills && !skillMatches(o.especialidad, profile.skills)
        ? " — ojo, no es exactamente tu especialidad"
        : "";
    return valor.label
      ? `• ${desc} — ${valor.label}${skillNote}`
      : `• ${desc}${skillNote}`;
  });

  return [
    `${greeting} — tu perfil quedó aprobado. Mira lo que tengo abierto en ${profile.ciudad}:`,
    "",
    ...lines,
    "",
    "¿Te interesa alguno? Dime cuál y te apunto.",
  ].join("\n");
}
