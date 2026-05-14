// Computes SHA256 of manos-system.ts once at module load.
// Used by llm.ts to stamp every llm_call evento with a prompt version.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { createLogger } from "@redin/shared";

const log = createLogger("manos:prompt-sha");

function computeSha(): string {
  try {
    const thisDir = dirname(fileURLToPath(import.meta.url));
    const promptPath = join(thisDir, "prompts", "manos-system.ts");
    const contents = readFileSync(promptPath);
    return createHash("sha256").update(contents).digest("hex");
  } catch (e) {
    log.warn("could not read manos-system.ts for SHA — falling back to 'unknown'", {
      error: e instanceof Error ? e.message : String(e),
    });
    return "unknown";
  }
}

export const MANOS_PROMPT_SHA: string = computeSha();
