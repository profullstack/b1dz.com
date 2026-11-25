/**
 * GET /api/billing/status
 *
 * The caller's plan: Pro until (pro days and/or Profullstack Pass), this
 * month's analyst cost against the cap, today's free questions, prepaid agent
 * credit, and the prices. Used by /pricing, /settings and `b1dz pro`.
 */
import type { NextRequest } from 'next/server';
import { authenticate, unauthorized } from '@/lib/api-auth';
import { agentBalanceCents, getEntitlement, userUsage } from '@/lib/entitlements';
import { monetizationConfig } from '@/lib/monetization';
import { createAdminSupabase } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const auth = await authenticate(req);
  if (!auth) return unauthorized();
  const admin = createAdminSupabase();
  const cfg = monetizationConfig();
  const [ent, usage, cents, cp] = await Promise.all([
    getEntitlement(admin, auth.userId),
    userUsage(admin, auth.userId),
    agentBalanceCents(auth.userId).catch(() => 0),
    admin.from('coinpay_identities').select('user_id').eq('user_id', auth.userId).maybeSingle(),
  ]);
  const iso = (ms: number | null) => (ms ? new Date(ms).toISOString() : null);
  return Response.json(
    {
      tier: ent.tier,
      via: ent.via,
      proUntil: iso(ent.proUntil),
      passUntil: iso(ent.passUntil),
      coinpayConnected: !!cp.data,
      analyst: {
        monthCostUsd: Math.round(usage.monthCostUsd * 1e4) / 1e4,
        monthCapUsd: ent.tier === 'pro' ? cfg.proMonthlyCapUsd : cfg.freeMonthlyCapUsd,
        todayQueries: usage.todayQueries,
        dailyQueries: ent.tier === 'pro' ? null : cfg.freeDailyQueries,
      },
      agentCreditUsd: cents / 100,
      prices: { pro30: cfg.pro30PriceUsd, pro365: cfg.pro365PriceUsd, agentCard: cfg.cardPriceUsd, agentAnalyst: cfg.analystPriceUsd },
    },
    { headers: { 'cache-control': 'no-store' } },
  );
}
