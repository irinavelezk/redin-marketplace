// Computes SHA256 of tono-system.ts file contents once at module load and caches
// it. Used by gemini.ts to stamp every llm_call evento with a prompt version.
// PRD §22: "SHA256 of tono-system.ts file contents, computed once at startup".

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { createLogger } from "@redin/shared";

const log = createLogger("tono:prompt-sha");

function computeSha(): string {
  try {
    const thisDir = dirname(fileURLToPath(import.meta.url));
    const promptPath = join(thisDir, "prompts", "tono-system.ts");
    const contents = readFileSync(promptPath);
    return createHash("sha256").update(contents).digest("hex");
  } catch (e) {
    log.warn("could not read tono-system.ts for SHA — falling back to 'unknown'", {
      error: e instanceof Error ? e.message : String(e),
    });
    return "unknown";
  }
}

export const TONO_PROMPT_SHA: string = computeSha();
