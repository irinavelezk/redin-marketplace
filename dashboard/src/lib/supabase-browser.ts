// Browser-only Supabase helper. Safe to import from client components.
// Never imports `next/headers` or any server-only module.

import { createBrowserClient as createSsrBrowser } from "@supabase/ssr";
import type { Database } from "@redin/shared";

export function browserClient() {
  const url =
    process.env.NEXT_PUBLIC_SUPABASE_URL || (process.env.SUPABASE_URL ?? "");
  const key =
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
    (process.env.SUPABASE_PUBLISHABLE_KEY ?? "");
  return createSsrBrowser<Database>(url, key);
}
