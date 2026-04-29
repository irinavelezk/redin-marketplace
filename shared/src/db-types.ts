// Redin Marketplace v1 — Supabase DB types
// Hand-authored to match /marketplace/migrations/001_init.sql exactly.
// Regenerate via `npm run gen:types` once SUPABASE_ACCESS_TOKEN is valid.

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

// ---------- Enums / literal unions ----------

export type TecnicoEstado = "activo" | "pausado" | "baneado";
export type QualificationState =
  | "pending"
  | "needs_review"
  | "needs_call"
  | "qualified"
  | "rejected";
export type QualificationCallOutcome =
  | "approved"
  | "rejected"
  | "needs_more_info"
  | "no_show";
export type SessionChannel = "whatsapp" | "dashboard";
export type MessageRole = "user" | "assistant" | "tool";
export type PostulacionState =
  | "postulado"
  | "preseleccionado"
  | "asignado"
  | "rechazado"
  | "descartado"
  | "completado";
export type ContratoStatus = "borrador" | "enviado" | "firmado" | "cancelado";
export type DocumentoTipo =
  | "cedula"
  | "cert_electrica"
  | "arl"
  | "ss"
  | "altura"
  | "antecedentes"
  | "otro";
export type EventoType =
  | "tecnico_registered"
  | "postulacion_created"
  | "shortlist_proposed"
  | "shortlist_decided"
  | "hr_decision"
  | "contract_drafted"
  | "contract_sent"
  | "contract_signed"
  | "contract_cancelled"
  | "escalation"
  | "document_uploaded"
  | "document_validated"
  | "offer_sent"
  | "agent_tool_call"
  | "message_received"
  | "message_sent"
  | string; // open-ended

// ---------- Table row types ----------
// `type` (not `interface`) — required so these shapes extend `Record<string, unknown>`,
// which the Supabase `GenericTable.Row` constraint demands. Interfaces in strict mode
// are NOT assignable to Record because they lack an index signature — even though
// every property is indexable at runtime. See:
//   https://github.com/microsoft/TypeScript/issues/15300

export type TecnicoExtendedRow = {
  tecnico_id: string;
  phone: string;
  lider_phone: string | null;
  estado: TecnicoEstado;
  onboarded_at: string;
  source: string | null;
  appsheet_synced_at: string | null;
  qualification_state: QualificationState;
  last_jid: string | null;
};

export type QualificationCallRow = {
  id: string;
  tecnico_id: string;
  scheduled_for: string | null;
  completed_at: string | null;
  outcome: QualificationCallOutcome | null;
  notes: string | null;
  hr_user: string | null;
  created_at: string;
};

export type TecnicoEvaluationRow = {
  id: string;
  tecnico_id: string;
  ot_id: string;
  evaluator: string;
  cumplimiento: number | null;
  calidad: number | null;
  actitud: number | null;
  puntualidad: number | null;
  recommend_rehire: boolean | null;
  notes: string | null;
  created_at: string;
};

// Aggregated view from migrations/003_qualification.sql.
export type TecnicoPerformanceRow = {
  tecnico_id: string;
  eval_count: number;
  avg_score: number | null;
  rehire_yes: number;
  rehire_no: number;
  jobs_completed: number;
  jobs_dropped: number;
};

export type SessionRow = {
  id: string;
  phone: string;
  channel: SessionChannel;
  started_at: string;
  last_active: string;
};

export type MessageRow = {
  id: string;
  session_id: string;
  role: MessageRole;
  content: string | null;
  tool_calls: Json | null;
  created_at: string;
};

export type PostulacionRow = {
  id: string;
  ot_id: string;
  tecnico_id: string;
  state: PostulacionState;
  mensaje: string | null;
  applied_at: string;
  decided_at: string | null;
  decided_by: string | null;
};

export type OfertaRow = {
  id: string;
  ot_id: string;
  tecnico_ids: string[];
  sent_at: string;
  expires_at: string | null;
  channel: string;
};

export type ContratoRow = {
  id: string;
  tecnico_id: string;
  ot_id: string | null;
  status: ContratoStatus;
  pdf_storage_path: string | null;
  signed_pdf_storage_path: string | null;
  zapsign_id: string | null;
  sent_at: string | null;
  signed_at: string | null;
  created_by: string | null;
};

export type DocumentoRow = {
  id: string;
  tecnico_id: string;
  tipo: DocumentoTipo;
  storage_path: string;
  validated_by: string | null;
  validated_at: string | null;
  uploaded_at: string;
};

export type EventoRow = {
  id: string;
  type: EventoType;
  entity_id: string | null;
  actor: string | null;
  meta: Json | null;
  created_at: string;
};

export type RatingRow = {
  id: string;
  ot_id: string;
  rater: string;
  ratee: string;
  stars: number;
  notes: string | null;
  created_at: string;
};

export type OutboundStatus = "pending" | "sent" | "failed";
export type OutboundKind = "text" | "document";
export type OutboundMessageRow = {
  id: string;
  phone: string;
  body: string;
  channel: string;
  status: OutboundStatus;
  attempts: number;
  created_at: string;
  sent_at: string | null;
  last_error: string | null;
  meta: Json | null;
  kind: OutboundKind;
  attachment_path: string | null;
  attachment_filename: string | null;
  attachment_bucket: string | null;
};

// Mirrors store the AppSheet row as jsonb `data`; we extract a few columns
// we query by (`ciudad`, `especialidad`, `estado` on ots_mirror).
export type MirrorRowBase = {
  row_id: string;
  data: Json;
  synced_at: string;
};

export type TecnicoMirrorRow = MirrorRowBase;
export type ClienteMirrorRow = MirrorRowBase;
export type ArquitectoMirrorRow = MirrorRowBase;
export type ActividadMirrorRow = MirrorRowBase;

export type OTMirrorRow = MirrorRowBase & {
  ciudad: string | null;
  especialidad: string | null;
  estado: string | null;
};

// ---------- Supabase Database schema handle ----------
// Shape compatible with @supabase/postgrest-js GenericSchema:
//   Tables: Record<string, { Row, Insert, Update, Relationships: GenericRelationship[] }>
//   Views:     Record<string, GenericView>
//   Functions: Record<string, GenericFunction>
// We don't use Views/Functions/Relationships in v1 — empty shapes satisfy the constraint.

// Empty relationships tuple common to every table (no FK typings in v1).
type NoRelationships = [];

// Make every nullable column optional in Insert (matches Postgres semantics:
// missing column → NULL). Keeps non-nullable columns required.
type NullableKeys<T> = {
  [K in keyof T]: null extends T[K] ? K : never;
}[keyof T];
type OptionalNulls<T> = Omit<T, NullableKeys<T>> & Partial<Pick<T, NullableKeys<T>>>;

// Helper to attach the Relationships constraint without repeating.
type Table<Row, Insert, Update> = {
  Row: Row;
  Insert: Insert;
  Update: Update;
  Relationships: NoRelationships;
};

export interface Database {
  public: {
    Tables: {
      tecnicos_extended: Table<
        TecnicoExtendedRow,
        OptionalNulls<
          Omit<
            TecnicoExtendedRow,
            "onboarded_at" | "estado" | "qualification_state"
          > & {
            onboarded_at?: string;
            estado?: TecnicoEstado;
            qualification_state?: QualificationState;
          }
        >,
        Partial<TecnicoExtendedRow>
      >;
      qualification_calls: Table<
        QualificationCallRow,
        OptionalNulls<
          Omit<QualificationCallRow, "id" | "created_at"> & {
            id?: string;
            created_at?: string;
          }
        >,
        Partial<QualificationCallRow>
      >;
      tecnico_evaluations: Table<
        TecnicoEvaluationRow,
        OptionalNulls<
          Omit<TecnicoEvaluationRow, "id" | "created_at"> & {
            id?: string;
            created_at?: string;
          }
        >,
        Partial<TecnicoEvaluationRow>
      >;
      sessions: Table<
        SessionRow,
        OptionalNulls<
          Omit<SessionRow, "id" | "started_at" | "last_active"> & {
            id?: string;
            started_at?: string;
            last_active?: string;
          }
        >,
        Partial<SessionRow>
      >;
      messages: Table<
        MessageRow,
        OptionalNulls<
          Omit<MessageRow, "id" | "created_at"> & {
            id?: string;
            created_at?: string;
          }
        >,
        Partial<MessageRow>
      >;
      postulaciones: Table<
        PostulacionRow,
        OptionalNulls<
          Omit<PostulacionRow, "id" | "state" | "applied_at"> & {
            id?: string;
            state?: PostulacionState;
            applied_at?: string;
          }
        >,
        Partial<PostulacionRow>
      >;
      ofertas: Table<
        OfertaRow,
        OptionalNulls<
          Omit<OfertaRow, "id" | "sent_at" | "channel"> & {
            id?: string;
            sent_at?: string;
            channel?: string;
          }
        >,
        Partial<OfertaRow>
      >;
      contratos: Table<
        ContratoRow,
        OptionalNulls<
          Omit<ContratoRow, "id" | "status"> & {
            id?: string;
            status?: ContratoStatus;
          }
        >,
        Partial<ContratoRow>
      >;
      documentos: Table<
        DocumentoRow,
        OptionalNulls<
          Omit<DocumentoRow, "id" | "uploaded_at"> & {
            id?: string;
            uploaded_at?: string;
          }
        >,
        Partial<DocumentoRow>
      >;
      eventos: Table<
        EventoRow,
        OptionalNulls<
          Omit<EventoRow, "id" | "created_at"> & {
            id?: string;
            created_at?: string;
          }
        >,
        Partial<EventoRow>
      >;
      ratings: Table<
        RatingRow,
        OptionalNulls<
          Omit<RatingRow, "id" | "created_at"> & {
            id?: string;
            created_at?: string;
          }
        >,
        Partial<RatingRow>
      >;
      outbound_messages: Table<
        OutboundMessageRow,
        OptionalNulls<
          Omit<
            OutboundMessageRow,
            "id" | "created_at" | "channel" | "status" | "attempts" | "kind"
          > & {
            id?: string;
            created_at?: string;
            channel?: string;
            status?: OutboundStatus;
            attempts?: number;
            kind?: OutboundKind;
          }
        >,
        Partial<OutboundMessageRow>
      >;
      tecnicos_mirror: Table<
        TecnicoMirrorRow,
        Omit<TecnicoMirrorRow, "synced_at"> & { synced_at?: string },
        Partial<TecnicoMirrorRow>
      >;
      ots_mirror: Table<
        OTMirrorRow,
        Omit<OTMirrorRow, "synced_at"> & { synced_at?: string },
        Partial<OTMirrorRow>
      >;
      clientes_mirror: Table<
        ClienteMirrorRow,
        Omit<ClienteMirrorRow, "synced_at"> & { synced_at?: string },
        Partial<ClienteMirrorRow>
      >;
      arquitectos_mirror: Table<
        ArquitectoMirrorRow,
        Omit<ArquitectoMirrorRow, "synced_at"> & { synced_at?: string },
        Partial<ArquitectoMirrorRow>
      >;
      actividades_mirror: Table<
        ActividadMirrorRow,
        Omit<ActividadMirrorRow, "synced_at"> & { synced_at?: string },
        Partial<ActividadMirrorRow>
      >;
    };
    Views: {
      tecnico_performance: {
        Row: TecnicoPerformanceRow;
        Relationships: NoRelationships;
      };
    };
    Functions: Record<never, never>;
    Enums: Record<never, never>;
    CompositeTypes: Record<never, never>;
  };
}
