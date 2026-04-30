/**
 * GET /api/store/invoices/:id
 * Returns the user's own invoice row + a fresh Coinpay status. Used by
 * the invoice page poller (every 5s).
 */
import type { NextRequest } from 'next/server';
import { authenticate, unauthorized } from '@/lib/api-auth';
import { fetchCoinPayPaymentStatus } from '@/lib/coinpay-client';
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
          maybeSingle: () => Promise<{ data: InvoiceRow | null; error: { message: string } | null }>;
        };
      };
    };
  };
  const { data, error } = await c.from('plugin_invoices')
    .select('id, user_id, plugin_id, coinpay_payment_id, amount_usd, blockchain, payment_address, crypto_amount, qr_code, status, expires_at, paid_at, forwarded_at, created_at, updated_at')
    .eq('id', id)
    .maybeSingle();
  if (error) return Response.json({ error: error.message }, { status: 500 });
  if (!data) return Response.json({ error: 'invoice not found' }, { status: 404 });
  if (data.user_id !== auth.userId) return Response.json({ error: 'unauthorized' }, { status: 403 });

  // Optionally refresh status from Coinpay so the UI shows fast progress
  // without waiting for the webhook to land.
  let liveStatus = data.status;
  if (data.coinpay_payment_id && data.status === 'pending') {
    const live = await fetchCoinPayPaymentStatus(data.coinpay_payment_id).catch(() => null);
    if (live && live.status && live.status !== 'unknown' && live.status !== data.status) {
      liveStatus = live.status;
      // Persist progress when Coinpay reports detected/confirmed/forwarded
      // so the UI flips even when webhook delivery is delayed. We use the
      // service-role client because RLS would otherwise block (the user
      // has no INSERT policy mid-tick; UPDATE via maybeSingle works under
      // their token but using the admin client is consistent with the
      // webhook path).
      try {
        const admin = createAdminSupabase() as unknown as {
          from: (t: string) => {
            update: (r: Record<string, unknown>) => {
              eq: (c: string, v: string) => Promise<{ error: { message: string } | null }>;
            };
          };
        };
        await admin.from('plugin_invoices').update({ status: liveStatus, updated_at: new Date().toISOString() }).eq('id', data.id);
      } catch {/* webhook will catch up */}
    }
  }

  return Response.json({ invoice: { ...data, status: liveStatus } });
}
