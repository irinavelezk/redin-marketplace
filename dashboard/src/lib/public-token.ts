// HMAC-signed tokens for the architect-facing public OT view at
// /publico/ot/[token]. The token is `<ot_id>.<sig>` where sig is a 16-char
// base64url-truncated HMAC-SHA256 over ot_id keyed by SUPABASE_SECRET_KEY.
//
// Properties:
//   - Deterministic: the same ot_id always produces the same token, so
//     architects can re-share without us tracking link issuance.
//   - Forgery-resistant: without the secret nobody can mint a valid token
//     for an OT they haven't seen.
//   - Revocable in bulk: rotating SUPABASE_SECRET_KEY invalidates all
//     previously-shared links at once. Per-link revocation isn't supported
//     in v1 — would require a server-side revocation list.
//   - No DB lookup needed for token resolution: the OT id is encoded
//     directly into the token, the sig only proves we minted it.

import "server-only";
import crypto from "node:crypto";

function secret(): string {
  const k = process.env.SUPABASE_SECRET_KEY ?? "";
  if (!k) throw new Error("SUPABASE_SECRET_KEY required for public-token signing");
  return k;
}

function sign(otId: string): string {
  return crypto
    .createHmac("sha256", secret())
    .update(otId)
    .digest("base64url")
    .slice(0, 16);
}

export function signOtPublicToken(otId: string): string {
  return `${encodeURIComponent(otId)}.${sign(otId)}`;
}

// Parses and verifies a token. Returns the ot_id on success, null on any
// failure (malformed, sig mismatch, missing secret). Uses timing-safe
// comparison so attackers can't probe the sig byte-by-byte.
export function verifyOtPublicToken(token: string): string | null {
  const idx = token.lastIndexOf(".");
  if (idx === -1) return null;
  let otId: string;
  try {
    otId = decodeURIComponent(token.slice(0, idx));
  } catch {
    return null;
  }
  if (!otId) return null;
  const presented = token.slice(idx + 1);
  let expected: string;
  try {
    expected = sign(otId);
  } catch {
    return null;
  }
  if (presented.length !== expected.length) return null;
  // Timing-safe equality
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return null;
  return crypto.timingSafeEqual(a, b) ? otId : null;
}
