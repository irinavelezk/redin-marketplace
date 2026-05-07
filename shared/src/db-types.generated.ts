export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      actividades_mirror: {
        Row: {
          data: Json
          row_id: string
          synced_at: string | null
        }
        Insert: {
          data: Json
          row_id: string
          synced_at?: string | null
        }
        Update: {
          data?: Json
          row_id?: string
          synced_at?: string | null
        }
        Relationships: []
      }
      arquitectos_mirror: {
        Row: {
          data: Json
          row_id: string
          synced_at: string | null
        }
        Insert: {
          data: Json
          row_id: string
          synced_at?: string | null
        }
        Update: {
          data?: Json
          row_id?: string
          synced_at?: string | null
        }
        Relationships: []
      }
      clientes_mirror: {
        Row: {
          data: Json
          row_id: string
          synced_at: string | null
        }
        Insert: {
          data: Json
          row_id: string
          synced_at?: string | null
        }
        Update: {
          data?: Json
          row_id?: string
          synced_at?: string | null
        }
        Relationships: []
      }
      contactos_mirror: {
        Row: {
          data: Json
          id_contacto: string | null
          row_id: string
          synced_at: string | null
          telefono: string | null
        }
        Insert: {
          data: Json
          id_contacto?: string | null
          row_id: string
          synced_at?: string | null
          telefono?: string | null
        }
        Update: {
          data?: Json
          id_contacto?: string | null
          row_id?: string
          synced_at?: string | null
          telefono?: string | null
        }
        Relationships: []
      }
      contratos: {
        Row: {
          created_by: string | null
          id: string
          ot_id: string | null
          pdf_storage_path: string | null
          sent_at: string | null
          signed_at: string | null
          signed_pdf_storage_path: string | null
          status: string | null
          tecnico_id: string
          zapsign_id: string | null
        }
        Insert: {
          created_by?: string | null
          id?: string
          ot_id?: string | null
          pdf_storage_path?: string | null
          sent_at?: string | null
          signed_at?: string | null
          signed_pdf_storage_path?: string | null
          status?: string | null
          tecnico_id: string
          zapsign_id?: string | null
        }
        Update: {
          created_by?: string | null
          id?: string
          ot_id?: string | null
          pdf_storage_path?: string | null
          sent_at?: string | null
          signed_at?: string | null
          signed_pdf_storage_path?: string | null
          status?: string | null
          tecnico_id?: string
          zapsign_id?: string | null
        }
        Relationships: []
      }
      documentos: {
        Row: {
          id: string
          storage_path: string
          tecnico_id: string
          tipo: string
          uploaded_at: string | null
          validated_at: string | null
          validated_by: string | null
        }
        Insert: {
          id?: string
          storage_path: string
          tecnico_id: string
          tipo: string
          uploaded_at?: string | null
          validated_at?: string | null
          validated_by?: string | null
        }
        Update: {
          id?: string
          storage_path?: string
          tecnico_id?: string
          tipo?: string
          uploaded_at?: string | null
          validated_at?: string | null
          validated_by?: string | null
        }
        Relationships: []
      }
      eventos: {
        Row: {
          actor: string | null
          created_at: string | null
          entity_id: string | null
          id: string
          meta: Json | null
          type: string
        }
        Insert: {
          actor?: string | null
          created_at?: string | null
          entity_id?: string | null
          id?: string
          meta?: Json | null
          type: string
        }
        Update: {
          actor?: string | null
          created_at?: string | null
          entity_id?: string | null
          id?: string
          meta?: Json | null
          type?: string
        }
        Relationships: []
      }
      messages: {
        Row: {
          content: string | null
          created_at: string | null
          id: string
          role: string
          session_id: string | null
          tool_calls: Json | null
        }
        Insert: {
          content?: string | null
          created_at?: string | null
          id?: string
          role: string
          session_id?: string | null
          tool_calls?: Json | null
        }
        Update: {
          content?: string | null
          created_at?: string | null
          id?: string
          role?: string
          session_id?: string | null
          tool_calls?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "messages_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      ofertas: {
        Row: {
          channel: string | null
          expires_at: string | null
          id: string
          ot_id: string
          sent_at: string | null
          tecnico_ids: string[]
        }
        Insert: {
          channel?: string | null
          expires_at?: string | null
          id?: string
          ot_id: string
          sent_at?: string | null
          tecnico_ids: string[]
        }
        Update: {
          channel?: string | null
          expires_at?: string | null
          id?: string
          ot_id?: string
          sent_at?: string | null
          tecnico_ids?: string[]
        }
        Relationships: []
      }
      ots_mirror: {
        Row: {
          ciudad: string | null
          data: Json
          especialidad: string | null
          estado: string | null
          row_id: string
          synced_at: string | null
        }
        Insert: {
          ciudad?: string | null
          data: Json
          especialidad?: string | null
          estado?: string | null
          row_id: string
          synced_at?: string | null
        }
        Update: {
          ciudad?: string | null
          data?: Json
          especialidad?: string | null
          estado?: string | null
          row_id?: string
          synced_at?: string | null
        }
        Relationships: []
      }
      outbound_messages: {
        Row: {
          attachment_bucket: string | null
          attachment_filename: string | null
          attachment_path: string | null
          attempts: number
          body: string
          channel: string
          created_at: string
          id: string
          kind: string
          last_error: string | null
          meta: Json | null
          phone: string
          sent_at: string | null
          status: string
        }
        Insert: {
          attachment_bucket?: string | null
          attachment_filename?: string | null
          attachment_path?: string | null
          attempts?: number
          body: string
          channel?: string
          created_at?: string
          id?: string
          kind?: string
          last_error?: string | null
          meta?: Json | null
          phone: string
          sent_at?: string | null
          status?: string
        }
        Update: {
          attachment_bucket?: string | null
          attachment_filename?: string | null
          attachment_path?: string | null
          attempts?: number
          body?: string
          channel?: string
          created_at?: string
          id?: string
          kind?: string
          last_error?: string | null
          meta?: Json | null
          phone?: string
          sent_at?: string | null
          status?: string
        }
        Relationships: []
      }
      postulaciones: {
        Row: {
          applied_at: string | null
          decided_at: string | null
          decided_by: string | null
          id: string
          mensaje: string | null
          ot_id: string
          state: string
          tecnico_id: string
        }
        Insert: {
          applied_at?: string | null
          decided_at?: string | null
          decided_by?: string | null
          id?: string
          mensaje?: string | null
          ot_id: string
          state?: string
          tecnico_id: string
        }
        Update: {
          applied_at?: string | null
          decided_at?: string | null
          decided_by?: string | null
          id?: string
          mensaje?: string | null
          ot_id?: string
          state?: string
          tecnico_id?: string
        }
        Relationships: []
      }
      qualification_calls: {
        Row: {
          completed_at: string | null
          created_at: string | null
          hr_user: string | null
          id: string
          notes: string | null
          outcome: string | null
          scheduled_for: string | null
          tecnico_id: string
        }
        Insert: {
          completed_at?: string | null
          created_at?: string | null
          hr_user?: string | null
          id?: string
          notes?: string | null
          outcome?: string | null
          scheduled_for?: string | null
          tecnico_id: string
        }
        Update: {
          completed_at?: string | null
          created_at?: string | null
          hr_user?: string | null
          id?: string
          notes?: string | null
          outcome?: string | null
          scheduled_for?: string | null
          tecnico_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "qualification_calls_tecnico_id_fkey"
            columns: ["tecnico_id"]
            isOneToOne: false
            referencedRelation: "tecnico_performance"
            referencedColumns: ["tecnico_id"]
          },
          {
            foreignKeyName: "qualification_calls_tecnico_id_fkey"
            columns: ["tecnico_id"]
            isOneToOne: false
            referencedRelation: "tecnicos_extended"
            referencedColumns: ["tecnico_id"]
          },
        ]
      }
      ratings: {
        Row: {
          created_at: string | null
          id: string
          notes: string | null
          ot_id: string
          ratee: string
          rater: string
          stars: number | null
        }
        Insert: {
          created_at?: string | null
          id?: string
          notes?: string | null
          ot_id: string
          ratee: string
          rater: string
          stars?: number | null
        }
        Update: {
          created_at?: string | null
          id?: string
          notes?: string | null
          ot_id?: string
          ratee?: string
          rater?: string
          stars?: number | null
        }
        Relationships: []
      }
      sessions: {
        Row: {
          channel: string
          id: string
          last_active: string | null
          phone: string
          started_at: string | null
        }
        Insert: {
          channel: string
          id?: string
          last_active?: string | null
          phone: string
          started_at?: string | null
        }
        Update: {
          channel?: string
          id?: string
          last_active?: string | null
          phone?: string
          started_at?: string | null
        }
        Relationships: []
      }
      tecnico_evaluations: {
        Row: {
          actitud: number | null
          calidad: number | null
          created_at: string | null
          cumplimiento: number | null
          evaluator: string
          id: string
          notes: string | null
          ot_id: string
          puntualidad: number | null
          recommend_rehire: boolean | null
          tecnico_id: string
        }
        Insert: {
          actitud?: number | null
          calidad?: number | null
          created_at?: string | null
          cumplimiento?: number | null
          evaluator: string
          id?: string
          notes?: string | null
          ot_id: string
          puntualidad?: number | null
          recommend_rehire?: boolean | null
          tecnico_id: string
        }
        Update: {
          actitud?: number | null
          calidad?: number | null
          created_at?: string | null
          cumplimiento?: number | null
          evaluator?: string
          id?: string
          notes?: string | null
          ot_id?: string
          puntualidad?: number | null
          recommend_rehire?: boolean | null
          tecnico_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "tecnico_evaluations_tecnico_id_fkey"
            columns: ["tecnico_id"]
            isOneToOne: false
            referencedRelation: "tecnico_performance"
            referencedColumns: ["tecnico_id"]
          },
          {
            foreignKeyName: "tecnico_evaluations_tecnico_id_fkey"
            columns: ["tecnico_id"]
            isOneToOne: false
            referencedRelation: "tecnicos_extended"
            referencedColumns: ["tecnico_id"]
          },
        ]
      }
      tecnicos_extended: {
        Row: {
          appsheet_synced_at: string | null
          estado: string | null
          last_jid: string | null
          lider_phone: string | null
          onboarded_at: string | null
          phone: string
          qualification_state: string | null
          source: string | null
          tecnico_id: string
        }
        Insert: {
          appsheet_synced_at?: string | null
          estado?: string | null
          last_jid?: string | null
          lider_phone?: string | null
          onboarded_at?: string | null
          phone: string
          qualification_state?: string | null
          source?: string | null
          tecnico_id: string
        }
        Update: {
          appsheet_synced_at?: string | null
          estado?: string | null
          last_jid?: string | null
          lider_phone?: string | null
          onboarded_at?: string | null
          phone?: string
          qualification_state?: string | null
          source?: string | null
          tecnico_id?: string
        }
        Relationships: []
      }
      tecnicos_mirror: {
        Row: {
          data: Json
          row_id: string
          synced_at: string | null
        }
        Insert: {
          data: Json
          row_id: string
          synced_at?: string | null
        }
        Update: {
          data?: Json
          row_id?: string
          synced_at?: string | null
        }
        Relationships: []
      }
    }
    Views: {
      tecnico_performance: {
        Row: {
          avg_score: number | null
          eval_count: number | null
          jobs_completed: number | null
          jobs_dropped: number | null
          rehire_no: number | null
          rehire_yes: number | null
          tecnico_id: string | null
        }
        Relationships: []
      }
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
