import type { NextRequest } from 'next/server';
import { CORS_HEADERS, revokeToken } from '@/lib/mcp-oauth';
import { createAdminSupabase } from '@/lib/supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// POST /api/oauth/revoke: RFC 7009. Always 200; ends the grant and its agent token.
export async function POST(req: NextRequest) {
  const type = req.headers.get('content-type') ?? '';
  let token = '';
  try {
    if (type.includes('application/json')) {
      const body = (await req.json()) as { token?: unknown };
      token = typeof body?.token === 'string' ? body.token : '';
    } else {
      token = new URLSearchParams(await req.text()).get('token') ?? '';
    }
  } catch {
    /* an unreadable body revokes nothing */
  }
  if (token) {
    try {
      await revokeToken(createAdminSupabase(), token);
    } catch (err) {
      console.error('[oauth] revoke failed', (err as Error).message);
    }
  }
  return new Response(null, { status: 200, headers: { ...CORS_HEADERS, 'cache-control': 'no-store' } });
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}
