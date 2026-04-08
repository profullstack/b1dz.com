/**
 * Universal API auth helper.
 *
 * Verifies the request comes from an authenticated user via EITHER:
 *   - Cookie session (browser, set by /api/auth/login)
 *   - Authorization: Bearer <access_token> header (CLI / SDK)
 *
 * Returns a server-side Supabase client scoped to the user — RLS still
 * applies, so any read/write under this client only sees the user's rows.
 */
import { createServerClient } from '@supabase/ssr';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { cookies } from 'next/headers';
import type { NextRequest } from 'next/server';

export interface AuthedRequest {
  client: SupabaseClient;
  userId: string;
  email: string | null;
}

const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const PUB = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;

/** Try cookie first, fall back to bearer token. */
export async function authenticate(req: NextRequest): Promise<AuthedRequest | null> {
  // 1. Bearer token path (CLI / SDK)
  const auth = req.headers.get('authorization');
  if (auth?.startsWith('Bearer ')) {
    const token = auth.slice(7);
    const client = createClient(URL_, PUB, {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data, error } = await client.auth.getUser(token);
    if (error || !data.user) return null;
    return { client, userId: data.user.id, email: data.user.email ?? null };
  }

  // 2. Cookie path (browser / web app)
  const cookieStore = await cookies();
  const client = createServerClient(URL_, PUB, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: () => {/* read-only */},
    },
  });
  const { data: { user } } = await client.auth.getUser();
  if (!user) return null;
  return { client, userId: user.id, email: user.email ?? null };
}

export function unauthorized() {
  return Response.json({ error: 'unauthorized' }, { status: 401 });
}
