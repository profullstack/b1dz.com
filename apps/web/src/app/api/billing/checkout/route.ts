/**
 * POST /api/billing/checkout  { product: 'pro-30' | 'pro-365' | 'agent-credit-10' | 'agent-credit-50' }
 *
 * Opens a CoinPay hosted checkout for a prepaid b1dz product and returns its
 * url. The invoice is a plugin_invoices row (plugin_id 'b1dz:<product>'), so
 * the existing CoinPay webhook and invoice poller settle it; settlement
 * credits pro_days or agent_cents to the credit ledger once
 * (lib/plugin-billing.ts).
 */
import type { NextRequest } from 'next/server';
import { authenticate, unauthorized } from '@/lib/api-auth';
import { coinpayConfigured, createCheckoutForPlugin } from '@/lib/coinpay-client';
import { PRODUCT_KIND, productById } from '@/lib/monetization';
import { createAdminSupabase } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const auth = await authenticate(req);
  if (!auth) return unauthorized();
  const body = (await req.json().catch(() => ({}))) as { product?: unknown };
  const product = productById(body.product);
  if (!product) return Response.json({ error: 'unknown product' }, { status: 400 });
  if (!coinpayConfigured()) return Response.json({ error: 'Checkout is not available right now.' }, { status: 503 });
  try {
    const r = await createCheckoutForPlugin({
      userId: auth.userId,
      email: auth.email ?? '',
      pluginId: product.invoiceKey,
      amountUsd: product.priceUsd,
      description: product.label,
      kind: 'install',
      client: createAdminSupabase(),
      productKind: PRODUCT_KIND,
    });
    return Response.json({ invoiceId: r.invoiceId, checkoutUrl: r.checkoutUrl, amountUsd: r.amountUsd, expiresAt: r.expiresAt });
  } catch (e) {
    console.error('[billing] checkout', (e as Error).message);
    return Response.json({ error: 'Could not open a CoinPay checkout. Try again in a minute.' }, { status: 502 });
  }
}
