// Read-only AppSheet client for the marketplace.
// Pattern mirrors /Users/irina/AI-driven-OS/autonomous/redin/agent/src/clients/appsheet.ts
// but we never call Edit/Add — enforce it at the type level.

export interface AppSheetConfig {
  appId: string;
  accessKey: string;
  baseUrl?: string;
}

export class AppSheetReadClient {
  private appId: string;
  private accessKey: string;
  private baseUrl: string;

  constructor(config: AppSheetConfig) {
    this.appId = config.appId;
    this.accessKey = config.accessKey;
    this.baseUrl = config.baseUrl ?? "https://api.appsheet.com";
  }

  private url(table: string): string {
    return `${this.baseUrl}/api/v2/apps/${this.appId}/tables/${encodeURIComponent(table)}/Action`;
  }

  async find<T = Record<string, string>>(
    table: string,
    opts?: { selector?: string }
  ): Promise<T[]> {
    const properties: Record<string, unknown> = { Locale: "en-US" };
    if (opts?.selector) properties.Selector = opts.selector;

    const res = await fetch(this.url(table), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ApplicationAccessKey: this.accessKey,
      },
      body: JSON.stringify({ Action: "Find", Properties: properties, Rows: [] }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `AppSheet ${table} Find failed: ${res.status} ${body.substring(0, 200)}`
      );
    }
    const text = await res.text();
    if (!text) return [];
    try {
      return JSON.parse(text) as T[];
    } catch (e) {
      throw new Error(`AppSheet ${table} returned non-JSON: ${text.substring(0, 200)}`);
    }
  }
}

export const MIRROR_TABLES = {
  TECNICOS: "Tecnicos",
  ORDENES: "Ordenes_Trabajo",
  CLIENTES: "Clientes",
  ARQUITECTOS: "Arquitecto",
  ACTIVIDADES: "Detalle de Actividades",
} as const;

// Narrow views of the AppSheet rows we care about. Keep loose — AppSheet
// silently adds/renames columns; we store the full row in `data` jsonb and
// only extract what we filter/sort by.
export interface AppSheetOT extends Record<string, string | undefined> {
  "Row ID"?: string;
  ID_Orden?: string;
  Ciudad?: string;
  Categoria?: string;
  Subcategoria?: string;
  Estado?: string;
  Descripcion?: string;
  Fecha_Creacion?: string;
  Numero_Orden?: string;
}
