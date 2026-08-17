import { createBrowserClient } from '@supabase/ssr'
import type { SupabaseClient } from '@supabase/supabase-js'

// Singleton instance — one client shared across the whole browser session.
// Creating multiple clients causes auth-lock contention ("Lock was released
// because another request stole it") and intermittent fetch failures.
let browserClient: SupabaseClient | undefined

export function createClient() {
  if (browserClient) return browserClient

  // Cast: this project's Supabase instance is shared with other apps, so
  // wacrm's tables live under a dedicated `wacrm` schema instead of the
  // default `public`. The cast keeps every call site's `SupabaseClient`
  // (implicitly `public`-schema) typing working unchanged; the runtime
  // client still targets `wacrm` regardless of the TS-facing type.
  browserClient = createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { db: { schema: 'wacrm' } }
  ) as unknown as SupabaseClient

  return browserClient
}
