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

/**
 * Agent-token auth (the "Coinbase for Agents" sub-account). Verifies an
 * `Authorization: Bearer b1dz_agent_…` token against the agent_tokens table.
 *
 * Agent tokens are NOT Supabase JWTs, so RLS-via-user-JWT does not apply — we
 * resolve a service-role (admin) client and the caller MUST scope every query
 * by `userId` explicitly. Fails closed: revoked/expired/unknown → null.
 */
export interface AuthedAgent {
  admin: SupabaseClient;
  userId: string;
  tokenId: string;
  scopes: string[];
  /** Full row (budget/window/allowlist) for downstream policy checks. */
  token: import('@b1dz/core').AgentTokenRow;
}

export async function authenticateAgent(req: NextRequest): Promise<AuthedAgent | null> {
  const auth = req.headers.get('authorization');
  if (!auth?.startsWith('Bearer ')) return null;
  const raw = auth.slice(7);
  const { isAgentToken } = await import('@b1dz/core');
  if (!isAgentToken(raw)) return null;

  const { hashAgentToken } = await import('./agent-tokens');
  const { createAdminSupabase } = await import('./supabase');
  const admin = createAdminSupabase();
  const hash = hashAgentToken(raw);
  const { data, error } = await admin
    .from('agent_tokens')
    .select('*')
    .eq('token_hash', hash)
    .is('revoked_at', null)
    .maybeSingle();
  if (error || !data) return null;

  // best-effort last_used_at touch (don't block on it)
  void admin.from('agent_tokens').update({ last_used_at: new Date().toISOString() }).eq('id', data.id);

  return {
    admin,
    userId: data.user_id,
    tokenId: data.id,
    scopes: Array.isArray(data.scopes) ? data.scopes : [],
    token: data as import('@b1dz/core').AgentTokenRow,
  };
}
