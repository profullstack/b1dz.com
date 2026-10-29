import type { NextRequest } from 'next/server';
import { authenticate, unauthorized } from '@/lib/api-auth';
import { createAdminSupabase } from '@/lib/supabase';
import { disconnectCoinpay, supabaseCoinpayStore } from '@/lib/coinpay-signin';

export const runtime = 'nodejs';

// POST /api/v1/coinpay/disconnect: Settings -> CoinPay -> Disconnect.
// Refused while CoinPay is the only way into the account.
export async function POST(req: NextRequest) {
  const authed = await authenticate(req);
  if (!authed) return unauthorized();
  const r = await disconnectCoinpay(authed.userId, authed.email, supabaseCoinpayStore(createAdminSupabase()));
  return r.ok ? Response.json({ ok: true }) : Response.json({ ok: false, error: r.error }, { status: 409 });
}
