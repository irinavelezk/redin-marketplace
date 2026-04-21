// Apply a SQL migration via Supabase Management API.
// Usage: npm run migrate -- migrations/002_whatever.sql
// Also supports: tsx scripts/run-migration.ts migrations/001_init.sql

import fs from "node:fs";
import path from "node:path";
import { requireEnv, createLogger } from "@redin/shared";

const log = createLogger("migrate");

async function main() {
  const file = process.argv[2];
  if (!file) {
    log.error("usage: npm run migrate -- <path-to-sql>");
    process.exit(1);
  }
  const abs = path.isAbsolute(file) ? file : path.resolve(process.cwd(), file);
  if (!fs.existsSync(abs)) {
    log.error("file not found", { file: abs });
    process.exit(1);
  }
  const sql = fs.readFileSync(abs, "utf8");
  const ref = requireEnv("SUPABASE_PROJECT_REF");
  const token = requireEnv("SUPABASE_MANAGEMENT_TOKEN");

  const res = await fetch(
    `https://api.supabase.com/v1/projects/${ref}/database/query`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ query: sql }),
    }
  );
  const text = await res.text();
  if (!res.ok) {
    log.error("migration failed", { status: res.status, body: text.slice(0, 1000) });
    process.exit(1);
  }
  log.info("migration applied", { file: abs, bytes: sql.length });
  if (text) log.debug("response", { body: text.slice(0, 200) });
}

main().catch((e) => {
  log.error("fatal", { error: e instanceof Error ? e.message : String(e) });
  process.exit(1);
});
