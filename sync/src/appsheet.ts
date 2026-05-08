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

  /**
   * Read a table without hardcoding its schema.
   *
   * Two guardrails before consumers map the rows:
   *   1. Every column in `requiredWriteColumns` must appear on at least one
   *      row. If any required column is missing from EVERY row, throws —
   *      the caller refuses to proceed (writing partial data is worse than
   *      stopping). This is the load-bearing check for any code that will
   *      later write to AppSheet.
   *   2. Any column outside `knownColumns` is collected into `unknown_columns`
   *      so the caller can log eventos{type:'appsheet_schema_drift'} once.
   *      Does NOT throw — the system adapts.
   *
   * Returned rows are unfiltered: all columns the API sent through.
   *
   * Used by scripts/import-legacy-tecnicos.ts to bootstrap pre-approved
   * técnicos. Future projector code (Stream B) should use this same helper
   * before issuing any Add/Edit so a silent AppSheet schema change can't
   * land partial writes in production.
   */
  async findWithSchemaCheck<T extends Record<string, unknown> = Record<string, string>>(
    table: string,
    options: {
      requiredWriteColumns: readonly string[];
      knownColumns?: readonly string[];
      selector?: string;
    }
  ): Promise<{ rows: T[]; unknown_columns: string[] }> {
    const rows = await this.find<T>(
      table,
      options.selector ? { selector: options.selector } : undefined
    );

    for (const required of options.requiredWriteColumns) {
      const present = rows.some((r) =>
        Object.prototype.hasOwnProperty.call(r, required)
      );
      if (!present) {
        throw new Error(
          `AppSheet ${table} schema drift: required column "${required}" is missing from every row. ` +
            `Refusing to proceed. Inspect the AppSheet table configuration.`
        );
      }
    }

    const unknown: string[] = [];
    if (options.knownColumns && options.knownColumns.length > 0) {
      const knownSet = new Set(options.knownColumns);
      const seen = new Set<string>();
      for (const r of rows) {
        for (const k of Object.keys(r)) {
          if (!knownSet.has(k)) seen.add(k);
        }
      }
      unknown.push(...seen);
    }

    return { rows, unknown_columns: unknown };
  }
}

export const MIRROR_TABLES = {
  TECNICOS: "Tecnicos",
  ORDENES: "Ordenes_Trabajo",
  CLIENTES: "Clientes",
  ARQUITECTOS: "Arquitecto",
  ACTIVIDADES: "Detalle de Actividades",
  CONTACTOS: "CONTACTOS",
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
