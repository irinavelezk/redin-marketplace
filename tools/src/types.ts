// Public tool I/O types. These are the agent's contract with the system.
// Each tool returns a `ToolResult<T>` so error handling is uniform and the
// agent never sees a thrown exception it can't attribute.

import type {
  ContratoRow,
  DocumentoTipo,
  PostulacionRow,
  TecnicoExtendedRow,
} from "@redin/shared";

export type Actor = `agent` | `tecnico:${string}` | `hr:${string}` | `system`;

export interface ToolSuccess<T> {
  ok: true;
  data: T;
}
export interface ToolError {
  ok: false;
  error: string;
  code?: string;
  retryable?: boolean;
}
export type ToolResult<T> = ToolSuccess<T> | ToolError;

export function ok<T>(data: T): ToolSuccess<T> {
  return { ok: true, data };
}
export function err(error: string, opts?: { code?: string; retryable?: boolean }): ToolError {
  return { ok: false, error, code: opts?.code, retryable: opts?.retryable };
}

// ---------- identify_user ----------
export interface IdentifyUserInput {
  phone: string;
}
// nombre / ciudad / especialidades / modalidad are enriched from the latest
// `tecnico_registered` event (or `tecnicos_mirror` for AppSheet-source rows).
// They live on the row object so the agent treats them as authoritative profile.
export type IdentifyUserTecnico = TecnicoExtendedRow & {
  nombre: string | null;
  ciudad: string | null;
  especialidades: string[] | null;
  modalidad: string | null;
};
export type IdentifyUserOutput =
  | { found: true; tecnico: IdentifyUserTecnico }
  | { found: false; phone: string };

// ---------- register_tecnico ----------
export interface RegisterTecnicoInput {
  phone: string;
  nombre: string;
  ciudad: string;
  especialidades: string[]; // 1+ items
  // Accepts "solo" as alias for "individual" — normalized in register-tecnico.ts.
  modalidad: "individual" | "solo" | "cuadrilla" | "lider";
  lider_phone?: string | null;
  source?: string;
  actor?: Actor;
}
export interface RegisterTecnicoOutput {
  tecnico_id: string;
  created: boolean; // false if already existed; we upsert by phone
}

// ---------- read_pending_ots ----------
export interface ReadPendingOtsInput {
  ciudad?: string;
  especialidad?: string;
  tecnico_id?: string; // if given, filters by tecnico's profile match
  limit?: number;
}
export interface PendingOtSummary {
  ot_id: string;
  ciudad: string | null;
  especialidad: string | null;
  estado: string | null;
  descripcion: string;
  shortlist_count: number;
  postulacion_count: number;
  created_at: string | null;
  // Budget — Valor_Estimado from AppSheet, parsed and pre-formatted as COP
  // ($ X.XXX.XXX). The agent should quote the label as-is; the numeric form
  // is exposed only for downstream sorts/filters.
  valor_estimado: number | null;
  valor_estimado_label: string | null;
  // Fecha_Programada from AppSheet, formatted dd/mm/yyyy. Tells the worker
  // when the job actually starts.
  fecha_programada: string | null;
}
export interface ReadPendingOtsOutput {
  ots: PendingOtSummary[];
  matched_by_profile: boolean;
}

// ---------- create_postulacion ----------
export interface CreatePostulacionInput {
  ot_id: string;
  tecnico_id: string;
  mensaje?: string;
  actor?: Actor;
}
export interface CreatePostulacionOutput {
  postulacion_id: string;
  state: "postulado" | "already_applied";
  // Echoed back so the agent can summarize the OT for the worker without
  // a separate read_pending_ots round-trip.
  ot: {
    ciudad: string | null;
    especialidad: string | null;
    descripcion: string;
    estado: string | null;
  };
}

// ---------- read_my_postulaciones ----------
export interface ReadMyPostulacionesInput {
  tecnico_id: string;
  limit?: number;
}
export interface PostulacionSummary {
  postulacion: PostulacionRow;
  ot: {
    ot_id: string;
    ciudad: string | null;
    especialidad: string | null;
    estado: string | null;
    descripcion: string;
  } | null;
}
export interface ReadMyPostulacionesOutput {
  postulaciones: PostulacionSummary[];
}

// ---------- read_my_contratos ----------
export interface ReadMyContratosInput {
  tecnico_id: string;
  limit?: number;
}
export interface ReadMyContratosOutput {
  contratos: ContratoRow[];
}

// ---------- upload_documento ----------
export interface UploadDocumentoInput {
  tecnico_id: string;
  tipo: DocumentoTipo;
  filename: string;
  // Either raw bytes or a storage_path if already uploaded out-of-band.
  content?: Uint8Array | Buffer;
  contentType?: string;
  storage_path?: string;
  actor?: Actor;
}
export interface UploadDocumentoOutput {
  documento_id: string;
  storage_path: string;
}

// ---------- escalate_to_hr ----------
export interface EscalateToHrInput {
  tecnico_id?: string;
  phone?: string;
  reason: string;
  context: string;
  actor?: Actor;
}
export interface EscalateToHrOutput {
  escalation_id: string;
  delivered_to_telegram: boolean;
}

// ---------- set_qualification_state ----------
// Agent-callable: only `needs_review` accepted. HR-only states (qualified /
// rejected / needs_call) are rejected at the tool layer.
export interface SetQualificationStateInput {
  tecnico_id: string;
  state: "needs_review";
  summary: string;
  actor?: Actor;
}
export interface SetQualificationStateOutput {
  tecnico_id: string;
  state: "needs_review" | "already_decided";
  prior_state?: string;
}

// ---------- log_event ----------
export interface LogEventInput {
  type: string;
  entity_id?: string | null;
  actor?: Actor;
  meta?: Record<string, unknown>;
}
export interface LogEventOutput {
  evento_id: string;
}
