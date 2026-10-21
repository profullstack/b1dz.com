/**
 * GET /api/store/invoices/:id
 * Returns the user's own invoice row + a fresh CoinPay status. Used by
 * the invoice page poller (every 5s).
 *
 * Hosted checkout invoices ask CoinPay for the session (with our business
 * key). A session CoinPay reports paid is settled here too, through the same
 * idempotent path as the webhook, so a late webhook never leaves a paid buyer
 * waiting and never double-extends.
 */
import type { NextRequest } from 'next/server';
import { authenticate, unauthorized } from '@/lib/api-auth';
import { fetchCheckoutSession, fetchCoinPayPaymentStatus } from '@/lib/coinpay-client';
import { settleInvoice, supabaseInvoiceStore } from '@/lib/plugin-billing';
import { createAdminSupabase } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

interface InvoiceRow {
  id: string;
  user_id: string;
  plugin_id: string;
  coinpay_payment_id: string | null;
  amount_usd: string;
  blockchain: string;
  payment_address: string | null;
  crypto_amount: string | null;
  qr_code: string | null;
  status: string;
  expires_at: string | null;
  paid_at: string | null;
  forwarded_at: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await authenticate(req);
  if (!auth) return unauthorized();
  const { id } = await ctx.params;
  if (!id) return Response.json({ error: 'invoice id required' }, { status: 400 });

  const c = auth.client as unknown as {
    from: (t: string) => {
      select: (s: string) => {
        eq: (col: string, val: string) => {
          eq: (col: string, val: string) => {
            maybeSingle: () => Promise<{ data: InvoiceRow | null; error: { message: string } | null }>;
          };
        };
      };
    };
  };
  const { data, error } = await c.from('plugin_invoices')
    .select('id, user_id, plugin_id, coinpay_payment_id, amount_usd, blockchain, payment_address, crypto_amount, qr_code, status, expires_at, paid_at, forwarded_at, metadata, created_at, updated_at')
    .eq('id', id)
    .eq('user_id', auth.userId)
    .maybeSingle();
  if (error) return Response.json({ error: 'Failed to fetch invoice' }, { status: 500 });
  if (!data) return Response.json({ error: 'invoice not found' }, { status: 404 });

  const sessionId = typeof data.metadata?.checkout_session_id === 'string' ? data.metadata.checkout_session_id : null;
  const checkoutUrl = typeof data.metadata?.checkout_url === 'string' ? data.metadata.checkout_url : null;
  let liveStatus = data.status;

  if (sessionId && !data.paid_at && (data.status === 'pending' || data.status === 'detected')) {
    const live = await fetchCheckoutSession(sessionId).catch(() => null);
    if (live?.status === 'paid') {
      try {
        const store = supabaseInvoiceStore(createAdminSupabase());
        await settleInvoice(store, { id: data.id, user_id: data.user_id, plugin_id: data.plugin_id, paid_at: data.paid_at, status: data.status, metadata: data.metadata }, { paymentId: live.paymentId, forwarded: false });
        liveStatus = 'confirmed';
      } catch {/* webhook will catch up */}
    } else if (live?.status === 'expired') {
      liveStatus = 'expired';
      try {
        await supabaseInvoiceStore(createAdminSupabase()).update(data.id, { status: 'expired', updated_at: new Date().toISOString() });
      } catch {/* cosmetic */}
    }
  } else if (!sessionId && data.coinpay_payment_id && data.status === 'pending') {
    // Legacy single-chain invoice: refresh status from the payment so the UI
    // shows progress without waiting for the webhook. Activation stays with
    // the webhook.
    const live = await fetchCoinPayPaymentStatus(data.coinpay_payment_id).catch(() => null);
    if (live && live.status && live.status !== 'unknown' && live.status !== data.status) {
      liveStatus = live.status;
      try {
        await supabaseInvoiceStore(createAdminSupabase()).update(data.id, { status: liveStatus, updated_at: new Date().toISOString() });
      } catch {/* webhook will catch up */}
    }
  }

  const { metadata: _metadata, ...rest } = data;
  void _metadata;
  return Response.json({ invoice: { ...rest, status: liveStatus, checkout_url: checkoutUrl } });
}
