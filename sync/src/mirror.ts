// AppSheet → Supabase mirror worker. Single-flight guarantee: if a refresh is
// in flight, callers await it instead of starting a second one.

import { createLogger, createServerClient, type Json, type ServerClient } from "@redin/shared";
import { AppSheetReadClient, MIRROR_TABLES, type AppSheetOT } from "./appsheet";

const log = createLogger("sync");

export interface MirrorResult {
  table: string;
  rows_seen: number;
  rows_upserted: number;
  duration_ms: number;
  error?: string;
}

export interface MirrorAllResult {
  started_at: string;
  finished_at: string;
  total_ms: number;
  per_table: MirrorResult[];
  ok: boolean;
}

export class SyncWorker {
  private supabase: ServerClient;
  private appsheet: AppSheetReadClient;
  // Single-flight: a pending refresh of "all" — extend as needed for per-table.
  private inflightAll: Promise<MirrorAllResult> | null = null;

  constructor(params: { supabase?: ServerClient; appsheet: AppSheetReadClient }) {
    this.supabase = params.supabase ?? createServerClient();
    this.appsheet = params.appsheet;
  }

  async refreshAll(): Promise<MirrorAllResult> {
    if (this.inflightAll) {
      log.debug("refreshAll: joining in-flight refresh");
      return this.inflightAll;
    }
    this.inflightAll = this._refreshAllInner().finally(() => {
      this.inflightAll = null;
    });
    return this.inflightAll;
  }

  private async _refreshAllInner(): Promise<MirrorAllResult> {
    const startedAt = new Date();
    log.info("refresh start");
    const results: MirrorResult[] = [];
    // Order doesn't strictly matter; OTs last so counts & joins have fresh técnicos/clientes.
    results.push(await this.mirrorTecnicos());
    results.push(await this.mirrorClientes());
    results.push(await this.mirrorArquitectos());
    results.push(await this.mirrorActividades());
    results.push(await this.mirrorOts());
    const finishedAt = new Date();
    const allOk = results.every((r) => !r.error);
    const totalMs = finishedAt.getTime() - startedAt.getTime();
    log.info("refresh done", {
      ok: allOk,
      total_ms: totalMs,
      per_table: results.map((r) => `${r.table}:${r.rows_upserted}/${r.rows_seen}`).join(" "),
    });
    return {
      started_at: startedAt.toISOString(),
      finished_at: finishedAt.toISOString(),
      total_ms: totalMs,
      per_table: results,
      ok: allOk,
    };
  }

  private async mirrorOts(): Promise<MirrorResult> {
    return this.mirrorGeneric<AppSheetOT>({
      tableName: MIRROR_TABLES.ORDENES,
      mirror: "ots_mirror",
      extract: (row) => ({
        row_id: (row["Row ID"] as string | undefined)?.trim() ?? "",
        data: row as unknown as Json,
        ciudad: stringOrNull(row.Ciudad),
        especialidad:
          stringOrNull(row.Categoria) ??
          stringOrNull(row.Subcategoria) ??
          null,
        estado: stringOrNull(row.Estado),
      }),
    });
  }

  private async mirrorTecnicos(): Promise<MirrorResult> {
    return this.mirrorGeneric({
      tableName: MIRROR_TABLES.TECNICOS,
      mirror: "tecnicos_mirror",
      extract: (row) => ({
        row_id: (row["Row ID"] as string | undefined)?.trim() ?? "",
        data: row as unknown as Json,
      }),
    });
  }
  private async mirrorClientes(): Promise<MirrorResult> {
    return this.mirrorGeneric({
      tableName: MIRROR_TABLES.CLIENTES,
      mirror: "clientes_mirror",
      extract: (row) => ({
        row_id: (row["Row ID"] as string | undefined)?.trim() ?? "",
        data: row as unknown as Json,
      }),
    });
  }
  private async mirrorArquitectos(): Promise<MirrorResult> {
    return this.mirrorGeneric({
      tableName: MIRROR_TABLES.ARQUITECTOS,
      mirror: "arquitectos_mirror",
      extract: (row) => ({
        row_id: (row["Row ID"] as string | undefined)?.trim() ?? "",
        data: row as unknown as Json,
      }),
    });
  }
  private async mirrorActividades(): Promise<MirrorResult> {
    return this.mirrorGeneric({
      tableName: MIRROR_TABLES.ACTIVIDADES,
      mirror: "actividades_mirror",
      extract: (row) => ({
        row_id: (row["Row ID"] as string | undefined)?.trim() ?? "",
        data: row as unknown as Json,
      }),
    });
  }

  private async mirrorGeneric<T extends Record<string, unknown>>(params: {
    tableName: string;
    mirror:
      | "ots_mirror"
      | "tecnicos_mirror"
      | "clientes_mirror"
      | "arquitectos_mirror"
      | "actividades_mirror";
    extract: (row: T) => {
      row_id: string;
      data: Json;
      ciudad?: string | null;
      especialidad?: string | null;
      estado?: string | null;
    };
  }): Promise<MirrorResult> {
    const start = Date.now();
    try {
      const rows = await this.appsheet.find<T>(params.tableName);
      const now = new Date().toISOString();
      const batches = chunk(
        rows
          .map(params.extract)
          .filter((r) => !!r.row_id)
          .map((r) => ({ ...r, synced_at: now })),
        500
      );
      let upserted = 0;
      for (const b of batches) {
        const { error } = await this.supabase
          .from(params.mirror)
          // @ts-expect-error — Supabase typing gets cranky about union of mirror row shapes
          .upsert(b, { onConflict: "row_id" });
        if (error) {
          log.error(`mirror upsert failed for ${params.mirror}`, { error: error.message });
          return {
            table: params.tableName,
            rows_seen: rows.length,
            rows_upserted: upserted,
            duration_ms: Date.now() - start,
            error: error.message,
          };
        }
        upserted += b.length;
      }
      return {
        table: params.tableName,
        rows_seen: rows.length,
        rows_upserted: upserted,
        duration_ms: Date.now() - start,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log.error(`mirror failed for ${params.tableName}`, { error: msg });
      return {
        table: params.tableName,
        rows_seen: 0,
        rows_upserted: 0,
        duration_ms: Date.now() - start,
        error: msg,
      };
    }
  }
}

function stringOrNull(v: unknown): string | null {
  if (typeof v === "string" && v.trim() !== "") return v.trim();
  return null;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
