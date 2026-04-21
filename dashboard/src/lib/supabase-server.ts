// Server-only Supabase helpers. Imports `next/headers` — only safe from
// Server Components, Route Handlers, and Server Actions.

import "server-only";
import { createServerClient as createSsrServer } from "@supabase/ssr";
import { cookies } from "next/headers";
import type { Database } from "@redin/shared";
import { createServerClient as createServiceClientInner } from "@redin/shared";

export function serverClientBoundToCookies() {
  const url =
    process.env.NEXT_PUBLIC_SUPABASE_URL || (process.env.SUPABASE_URL ?? "");
  const key =
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
    (process.env.SUPABASE_PUBLISHABLE_KEY ?? "");
  const cookieStore = cookies();
  return createSsrServer<Database>(url, key, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Called from a server component — set is not available. Safe to ignore;
          // middleware handles session refresh if we add it later.
        }
      },
    },
  });
}

// Service client — bypasses RLS. ONLY for route handlers / server actions where
// the request has been separately authorized.
export function serviceClient() {
  return createServiceClientInner();
}
