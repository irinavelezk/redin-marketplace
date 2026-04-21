/**
 * Seed validation harness — run with:
 *
 *   tsx qa/seeds/validate.ts
 *
 * from the marketplace/ root. Exits 0 if all YAML files parse + schema-validate.
 * Exits 1 and prints errors if any seed fails.
 *
 * Requires:
 *   - tsx (already a devDep at marketplace root)
 *   - zod (must be available; add to root devDeps if not: npm i -D zod)
 *   - js-yaml (npm i -D js-yaml @types/js-yaml if not present)
 */

import { readFileSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { parseSeedYaml } from "./schema.js";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const SEEDS_ROOT = __dirname;

const CATEGORIES = ["journeys", "refusals", "redteam"] as const;

// ---------------------------------------------------------------------------
// Collect all YAML files
// ---------------------------------------------------------------------------

interface FileResult {
  path: string;
  ok: boolean;
  error?: string;
}

const results: FileResult[] = [];

for (const cat of CATEGORIES) {
  const dir = join(SEEDS_ROOT, cat);
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"));
  } catch {
    console.warn(`[WARN] Directory not found: ${dir}`);
    continue;
  }

  for (const file of files) {
    const fullPath = join(dir, file);
    const expectedName = basename(file, ".yaml").replace(".yml", "");

    try {
      const raw = readFileSync(fullPath, "utf-8");
      const parsed = yaml.load(raw);
      const seed = parseSeedYaml(parsed);

      // Extra check: name field must match filename
      if (seed.name !== expectedName) {
        results.push({
          path: fullPath,
          ok: false,
          error: `name field "${seed.name}" does not match filename "${expectedName}"`,
        });
        continue;
      }

      // Extra check: category must match directory
      const expectedCategory = cat === "journeys" ? "journey" : cat === "refusals" ? "refusal" : "redteam";
      if (seed.category !== expectedCategory) {
        results.push({
          path: fullPath,
          ok: false,
          error: `category "${seed.category}" does not match directory "${cat}" (expected "${expectedCategory}")`,
        });
        continue;
      }

      results.push({ path: fullPath, ok: true });
    } catch (err) {
      results.push({
        path: fullPath,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const passed = results.filter((r) => r.ok);
const failed = results.filter((r) => !r.ok);

console.log(`\n=== Redin Seed Corpus Validation ===\n`);

for (const r of results) {
  const label = r.ok ? "PASS" : "FAIL";
  const rel = r.path.replace(SEEDS_ROOT, "").replace(/^\//, "");
  if (r.ok) {
    console.log(`  [${label}] ${rel}`);
  } else {
    console.log(`  [${label}] ${rel}`);
    console.log(`         ${r.error}`);
  }
}

console.log(`\nResult: ${passed.length} passed, ${failed.length} failed out of ${results.length} seeds.`);

// Coverage summary
const journeyCount = results.filter((r) => r.ok && r.path.includes("/journeys/")).length;
const refusalCount = results.filter((r) => r.ok && r.path.includes("/refusals/")).length;
const redteamCount = results.filter((r) => r.ok && r.path.includes("/redteam/")).length;

console.log(`\nCoverage:`);
console.log(`  Journeys  (need 7): ${journeyCount}`);
console.log(`  Refusals  (need 6): ${refusalCount}`);
console.log(`  Redteam   (need 10): ${redteamCount}`);
console.log(`  Total     (need 20): ${journeyCount + refusalCount + redteamCount}`);

const coverageOk =
  journeyCount >= 7 &&
  refusalCount >= 6 &&
  redteamCount >= 10 &&
  journeyCount + refusalCount + redteamCount >= 20;

if (failed.length > 0 || !coverageOk) {
  if (!coverageOk) {
    console.log(`\n[BLOCKED] Coverage gate not met.`);
  }
  process.exit(1);
}

console.log(`\n[OK] All seeds pass schema validation and coverage gate.\n`);
