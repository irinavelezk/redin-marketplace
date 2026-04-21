// Optional: regenerate shared/src/db-types.ts from the live Supabase DB using
// the Supabase CLI. Hand-authored types are the source of truth in v1 — the
// generated file is a cross-check. Requires `npx supabase` on PATH.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { requireEnv, createLogger } from "@redin/shared";

const log = createLogger("gen-types");

async function main() {
  const ref = requireEnv("SUPABASE_PROJECT_REF");
  const token = requireEnv("SUPABASE_MANAGEMENT_TOKEN");
  const outPath = path.resolve(process.cwd(), "shared/src/db-types.generated.ts");

  const env = { ...process.env, SUPABASE_ACCESS_TOKEN: token };
  const child = spawn(
    "npx",
    ["--yes", "supabase@latest", "gen", "types", "typescript", "--project-id", ref],
    { env, stdio: ["ignore", "pipe", "inherit"] }
  );
  const chunks: Buffer[] = [];
  child.stdout.on("data", (c) => chunks.push(c));
  const code: number = await new Promise((r) => child.on("exit", (c) => r(c ?? 1)));
  if (code !== 0) {
    log.error("gen failed", { code });
    process.exit(code);
  }
  const out = Buffer.concat(chunks).toString("utf8");
  fs.writeFileSync(outPath, out);
  log.info("types regenerated", { out: outPath, bytes: out.length });
}

main().catch((e) => {
  log.error("fatal", { error: e instanceof Error ? e.message : String(e) });
  process.exit(1);
});
