import type { NextRequest } from 'next/server';
import { authenticate, authenticateAgent } from '@/lib/api-auth';

/**
 * Who is asking for research.
 *
 *  - 'user': a signed-in person (cookie, or a Supabase bearer from the CLI).
 *    Every card is free for them; /terminal never charges per card.
 *  - 'agent': an agent token (`Authorization: Bearer b1dz_agent_…`). Free
 *    cards are free; metered cards (derived analytics, FRED, EIA) are paid
 *    by x402 or from the owner's prepaid agent credit (lib/agent-pay.ts).
 *  - 'anon': no credential. Free cards answer 401 as before; a metered card
 *    can be bought by x402 alone, so an agent without an account can pay.
 */
export type ResearchCaller =
  | { kind: 'user'; userId: string }
  | { kind: 'agent'; userId: string; agentTokenId: string }
  | { kind: 'anon' };

export async function researchPrincipal(req: NextRequest): Promise<ResearchCaller> {
  const bearer = req.headers.get('authorization') ?? '';
  if (/^Bearer\s+b1dz_agent_/i.test(bearer)) {
    const a = await authenticateAgent(req);
    return a ? { kind: 'agent', userId: a.userId, agentTokenId: a.tokenId } : { kind: 'anon' };
  }
  const u = await authenticate(req);
  return u ? { kind: 'user', userId: u.userId } : { kind: 'anon' };
}

/** Back-compat: the caller's user id, or null. */
export async function researchCaller(req: NextRequest): Promise<string | null> {
  const c = await researchPrincipal(req);
  return c.kind === 'anon' ? null : c.userId;
}

export function researchUnauthorized() {
  return Response.json(
    { error: 'unauthorized: sign in, or send Authorization: Bearer <b1dz_agent_ token>. The catalog at /api/research is public.' },
    { status: 401 },
  );
}
