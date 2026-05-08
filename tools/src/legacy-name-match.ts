// Spanish-aware name similarity for legacy worker reconciliation.
//
// Used by find_legacy_by_name to detect when a cold-path worker's name
// matches an approved + incomplete legacy worker (CASE A on a new phone).
// Pure functions — no DB, no globals, no network. Deterministic.
//
// Threshold defaults: distance <= 2 OR similarity >= 0.80 after normalization.
// Tune via opts on findMatches() if Test G surfaces noise.

export interface NameMatch {
  tecnico_id: string;
  nombre: string;
  /** Levenshtein edit distance between normalized names. 0 = identical. */
  distance: number;
  /** 1 - distance / max(len). Rounded to 2dp. 1.0 = identical. */
  similarity: number;
}

/**
 * Normalize a Spanish name for comparison:
 *   - NFD decomposition + combining-mark strip ("á" -> "a")
 *   - lowercase
 *   - replace non-letter chars with space
 *   - collapse whitespace + trim
 */
export function normalizeName(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Standard DP Levenshtein. O(m*n) time, O(n) space. */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = dp[0]!;
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j]!;
      dp[j] =
        a[i - 1] === b[j - 1]
          ? prev
          : 1 + Math.min(prev, dp[j - 1]!, dp[j]!);
      prev = tmp;
    }
  }
  return dp[n]!;
}

export interface FindMatchesOptions {
  /** Max Levenshtein distance to count as a hit. Default 2. */
  maxDistance?: number;
  /** Min similarity (1 - dist/maxlen) to count as a hit. Default 0.80. */
  minSimilarity?: number;
  /** Cap returned matches. Default 5. */
  topK?: number;
}

export function findMatches(
  query: string,
  candidates: { tecnico_id: string; nombre: string }[],
  opts: FindMatchesOptions = {}
): NameMatch[] {
  const maxDistance = opts.maxDistance ?? 2;
  const minSimilarity = opts.minSimilarity ?? 0.8;
  const topK = opts.topK ?? 5;

  const q = normalizeName(query);
  if (q.length === 0) return [];

  const out: NameMatch[] = [];
  for (const c of candidates) {
    const n = normalizeName(c.nombre);
    if (n.length === 0) continue;
    const d = levenshtein(q, n);
    const sim = 1 - d / Math.max(q.length, n.length);
    if (d <= maxDistance || sim >= minSimilarity) {
      out.push({
        tecnico_id: c.tecnico_id,
        nombre: c.nombre,
        distance: d,
        similarity: Math.round(sim * 100) / 100,
      });
    }
  }
  out.sort((a, b) => a.distance - b.distance || b.similarity - a.similarity);
  return out.slice(0, topK);
}
