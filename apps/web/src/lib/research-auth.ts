import type { NextRequest } from 'next/server';
import { authenticate, authenticateAgent } from '@/lib/api-auth';

/**
 * Research cards cost a fetch from a public source each, so callers must be
 * known: a signed-in user (cookie or Supabase bearer) or an agent token
 * (`Authorization: Bearer b1dz_agent_…`). Returns the caller's user id, or null.
 */
export async function researchCaller(req: NextRequest): Promise<string | null> {
  const bearer = req.headers.get('authorization') ?? '';
  if (/^Bearer\s+b1dz_agent_/i.test(bearer)) return (await authenticateAgent(req))?.userId ?? null;
  return (await authenticate(req))?.userId ?? null;
}

export function researchUnauthorized() {
  return Response.json(
    { error: 'unauthorized: sign in, or send Authorization: Bearer <b1dz_agent_ token>. The catalog at /api/research is public.' },
    { status: 401 },
  );
}
