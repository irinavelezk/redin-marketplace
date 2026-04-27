// Function-calling declarations for Toño's 9 tools.
// Kept in sync with types.ts by hand — any change to tool I/O types must update this file.
// Type names are UPPERCASE (legacy from Gemini integration); tono/src/llm.ts lowercases
// them when converting to Anthropic input_schema. New entries should keep the uppercase
// convention until the file is migrated to plain JSON Schema.

// PRD §20 input length caps — enforced at tool handler layer.
export const INPUT_CAPS = {
  nombre: 80,        // register_tecnico.nombre
  mensaje: 500,      // create_postulacion.mensaje
  whatsapp: 2000,    // inbound WA text before LLM assembly
} as const;

export const TOOL_DECLARATIONS = [
  {
    name: "identify_user",
    description:
      "Busca un técnico por teléfono. Siempre llámalo como PRIMER paso. Retorna {found: true, tecnico: {...}} o {found: false, phone}.",
    parameters: {
      type: "OBJECT",
      properties: {
        phone: { type: "STRING", description: "Teléfono en E.164 o local colombiano" },
      },
      required: ["phone"],
    },
  },
  {
    name: "register_tecnico",
    description:
      "Crea el perfil de un nuevo técnico. Solo úsalo después de preguntar nombre, ciudad, especialidades y modalidad. Idempotente en phone.",
    parameters: {
      type: "OBJECT",
      properties: {
        phone: { type: "STRING" },
        nombre: { type: "STRING" },
        ciudad: { type: "STRING" },
        especialidades: { type: "ARRAY", items: { type: "STRING" } },
        modalidad: {
          type: "STRING",
          enum: ["individual", "solo", "cuadrilla", "lider"],
          description:
            "solo (alias: individual), cuadrilla, o lider. El prompt de Toño dice 'solo'; ambos se aceptan.",
        },
        lider_phone: {
          type: "STRING",
          description:
            "Solo si el técnico viene con un maestro/líder que ya responde por él",
        },
        source: {
          type: "STRING",
          description: "warm | ape | facebook | referral | dashboard | whatsapp",
        },
      },
      required: ["phone", "nombre", "ciudad", "especialidades", "modalidad"],
    },
  },
  {
    name: "read_pending_ots",
    description:
      "Lista OTs abiertas. Sin filtros retorna todas las pendientes. Si pasas tecnico_id, Toño prioriza por ciudad/especialidad del técnico.",
    parameters: {
      type: "OBJECT",
      properties: {
        ciudad: { type: "STRING" },
        especialidad: { type: "STRING" },
        tecnico_id: { type: "STRING" },
        limit: { type: "INTEGER" },
      },
    },
  },
  {
    name: "create_postulacion",
    description:
      "Registra que un técnico se postuló a una OT. Idempotente: si ya existe la postulación, retorna {state: 'already_applied'}.",
    parameters: {
      type: "OBJECT",
      properties: {
        ot_id: { type: "STRING" },
        tecnico_id: { type: "STRING" },
        mensaje: { type: "STRING" },
      },
      required: ["ot_id", "tecnico_id"],
    },
  },
  {
    name: "read_my_postulaciones",
    description: "Lista todas las postulaciones de un técnico, con estado y datos de cada OT.",
    parameters: {
      type: "OBJECT",
      properties: {
        tecnico_id: { type: "STRING" },
        limit: { type: "INTEGER" },
      },
      required: ["tecnico_id"],
    },
  },
  {
    name: "read_my_contratos",
    description:
      "Lista contratos del técnico (borrador, enviado, firmado, cancelado).",
    parameters: {
      type: "OBJECT",
      properties: {
        tecnico_id: { type: "STRING" },
        limit: { type: "INTEGER" },
      },
      required: ["tecnico_id"],
    },
  },
  {
    name: "upload_documento",
    description:
      "Registra un documento ya subido a Storage (cédula, ARL, certificados). No se usa desde WhatsApp directamente — Toño le pide al técnico subirlo por el dashboard.",
    parameters: {
      type: "OBJECT",
      properties: {
        tecnico_id: { type: "STRING" },
        tipo: {
          type: "STRING",
          enum: ["cedula", "cert_electrica", "arl", "ss", "altura", "antecedentes", "otro"],
        },
        filename: { type: "STRING" },
        storage_path: {
          type: "STRING",
          description: "Si el archivo ya está en Storage, pasa el path y se registra sin re-subir",
        },
        contentType: { type: "STRING" },
      },
      required: ["tecnico_id", "tipo", "filename"],
    },
  },
  {
    name: "escalate_to_hr",
    description:
      "Úsalo cuando el técnico pide hablar con una persona, cuando tu confianza es baja, o cuando hay un problema que no puedes resolver. Notifica a HR por Telegram.",
    parameters: {
      type: "OBJECT",
      properties: {
        tecnico_id: { type: "STRING" },
        phone: { type: "STRING" },
        reason: {
          type: "STRING",
          description: "1 frase — por qué necesita HR",
        },
        context: {
          type: "STRING",
          description: "Resumen de la conversación y qué necesita HR resolver",
        },
      },
      required: ["reason", "context"],
    },
  },
  {
    name: "log_event",
    description:
      "Registra una observación del agente: frustración, duda, confirmación implícita. Usado para medición HITL — no es visible para el técnico.",
    parameters: {
      type: "OBJECT",
      properties: {
        type: { type: "STRING" },
        entity_id: { type: "STRING" },
        meta: { type: "OBJECT" },
      },
      required: ["type"],
    },
  },
] as const;

export type ToolName = (typeof TOOL_DECLARATIONS)[number]["name"];

export const TOOL_NAMES: ToolName[] = TOOL_DECLARATIONS.map((d) => d.name);
