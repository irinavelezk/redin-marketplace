// Minimal structured logger. One line per event — greppable in Railway logs.
// Not pinning a library; swap for pino later if we need log levels + binding.

export interface LogFields {
  [key: string]: unknown;
}

function stamp(): string {
  return new Date().toISOString();
}

function fmt(level: string, scope: string, msg: string, fields?: LogFields): string {
  const base = `${stamp()} ${level} [${scope}] ${msg}`;
  if (!fields) return base;
  const parts: string[] = [];
  for (const [k, v] of Object.entries(fields)) {
    let val: string;
    if (v === undefined) continue;
    if (typeof v === "string") val = v.length > 500 ? v.substring(0, 500) + "..." : v;
    else if (typeof v === "number" || typeof v === "boolean") val = String(v);
    else {
      try {
        val = JSON.stringify(v);
        if (val.length > 500) val = val.substring(0, 500) + "...";
      } catch {
        val = "[unserializable]";
      }
    }
    parts.push(`${k}=${val}`);
  }
  return parts.length > 0 ? `${base} | ${parts.join(" ")}` : base;
}

export function createLogger(scope: string) {
  return {
    info: (msg: string, fields?: LogFields) => console.log(fmt("INFO ", scope, msg, fields)),
    warn: (msg: string, fields?: LogFields) => console.warn(fmt("WARN ", scope, msg, fields)),
    error: (msg: string, fields?: LogFields) => console.error(fmt("ERROR", scope, msg, fields)),
    debug: (msg: string, fields?: LogFields) => {
      if (process.env.DEBUG) console.log(fmt("DEBUG", scope, msg, fields));
    },
  };
}

export type Logger = ReturnType<typeof createLogger>;
