// Centralized env accessor. Throws early and loudly instead of undefined sprinkles.

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === "") {
    throw new Error(`[env] Missing required env var: ${name}`);
  }
  return v;
}

export function optionalEnv(name: string, fallback?: string): string | undefined {
  const v = process.env[name];
  if (v === undefined || v.trim() === "") return fallback;
  return v;
}

export function boolEnv(name: string, fallback = false): boolean {
  const v = process.env[name];
  if (v === undefined) return fallback;
  return v === "1" || v.toLowerCase() === "true" || v.toLowerCase() === "yes";
}

export function intEnv(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v.trim() === "") return fallback;
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) throw new Error(`[env] ${name} is not an integer: "${v}"`);
  return n;
}
