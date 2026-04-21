// Supabase client factory. Two clients by design:
//   - server: uses SUPABASE_SECRET_KEY (bypasses RLS — only for trusted backends)
//   - browser: uses SUPABASE_PUBLISHABLE_KEY (subject to RLS — for dashboard)
// Do NOT pass the server client to any code that runs in the browser.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "./db-types";
import { requireEnv } from "./env";

export type ServerClient = SupabaseClient<Database>;
export type BrowserClient = SupabaseClient<Database>;

let cachedServer: ServerClient | null = null;

export function createServerClient(): ServerClient {
  if (cachedServer) return cachedServer;
  const url = requireEnv("SUPABASE_URL");
  const key = requireEnv("SUPABASE_SECRET_KEY");
  cachedServer = createClient<Database>(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
    global: {
      headers: { "x-redin-client": "marketplace-server" },
    },
  });
  return cachedServer;
}

// Browser client — instantiated on demand per request in Next.js.
// Do NOT cache at module level in SSR contexts (request-scoped clients are safer).
export function createBrowserClient(params?: {
  url?: string;
  publishableKey?: string;
}): BrowserClient {
  const url = params?.url ?? (process.env.NEXT_PUBLIC_SUPABASE_URL || requireEnv("SUPABASE_URL"));
  const key =
    params?.publishableKey ??
    (process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
      requireEnv("SUPABASE_PUBLISHABLE_KEY"));
  return createClient<Database>(url, key, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
    },
    global: {
      headers: { "x-redin-client": "marketplace-browser" },
    },
  });
}
