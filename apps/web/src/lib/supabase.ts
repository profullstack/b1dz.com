/**
 * Supabase clients for the Next.js app.
 *
 * - browser client: uses publishable key (RLS enforced)
 * - server client:  uses publishable key by default; can be swapped to the
 *                   secret key in trusted server contexts (cron, admin routes)
 *                   via createServerClient({ admin: true })
 */

import { createBrowserClient, createServerClient as createSsrServerClient } from '@supabase/ssr';
import { createClient } from '@supabase/supabase-js';
import { cookies } from 'next/headers';

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const PUBLISHABLE = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;
const SECRET = process.env.SUPABASE_SECRET_KEY;

export function createBrowserSupabase() {
  return createBrowserClient(URL, PUBLISHABLE);
}

export async function createServerSupabase() {
  const cookieStore = await cookies();
  return createSsrServerClient(URL, PUBLISHABLE, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (toSet) => {
        try { for (const { name, value, options } of toSet) cookieStore.set(name, value, options); } catch {}
      },
    },
  });
}

/** Admin client — bypasses RLS. Only use in trusted server contexts. */
export function createAdminSupabase() {
  if (!SECRET) throw new Error('SUPABASE_SECRET_KEY missing');
  return createClient(URL, SECRET, { auth: { persistSession: false, autoRefreshToken: false } });
}
