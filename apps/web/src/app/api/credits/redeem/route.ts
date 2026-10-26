/**
 * POST /api/credits/redeem  { code }
 * Redeems a credit code (CR-XXXX-XXXX-XXXX-XXXX) for the signed-in user.
 * 200 { ok, unit, amount, balance } | 400 { error, reason } for a refused code.
 */
import type { NextRequest } from 'next/server';
import { authenticate, unauthorized } from '@/lib/api-auth';
import { redeemCreditCode } from '@/lib/credits';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const auth = await authenticate(req);
  if (!auth) return unauthorized();
  const body = (await req.json().catch(() => null)) as { code?: unknown } | null;
  const code = typeof body?.code === 'string' ? body.code.trim() : '';
  if (!code) return Response.json({ error: 'Enter a code.', reason: 'invalid' }, { status: 400 });
  const r = await redeemCreditCode(auth.userId, code);
  if (!r.ok) return Response.json({ error: r.message, reason: r.reason }, { status: 400 });
  return Response.json(r);
}
