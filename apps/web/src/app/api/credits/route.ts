/** GET /api/credits — the caller's Pro-day balance (from redeemed codes and invite bonuses). */
import type { NextRequest } from 'next/server';
import { authenticate, unauthorized } from '@/lib/api-auth';
import { PRO_DAYS_UNIT, proDaysBalance } from '@/lib/credits';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const auth = await authenticate(req);
  if (!auth) return unauthorized();
  return Response.json({ unit: PRO_DAYS_UNIT, balance: await proDaysBalance(auth.userId) });
}
