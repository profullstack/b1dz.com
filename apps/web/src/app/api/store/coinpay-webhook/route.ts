/**
 * POST /api/store/coinpay-webhook
 *
 * Public endpoint, verified solely by HMAC over the raw body
 * (X-CoinPay-Signature: t=<unix>,v1=<hex>). CoinPay nests the payment under
 * `data` (top-level `id` is the event id); see readCoinPayEvent.
 *
 * Hosted checkout sessions settle by data.checkout_session_id (stored on the
 * invoice's metadata at create time) or our invoice_id in data.metadata,
 * checked against data.account_id. Older single-chain invoices still settle
 * by data.payment_id, so nothing in flight is orphaned.
 *
 * payment.confirmed or payment.forwarded = paid. Settlement claims paid_at
 * with a conditional update, so replays and forwarded-after-confirmed never
 * extend a subscription twice.
 *
 * Always 200 on a verified event (CoinPay retries on non-2xx) except when our
 * own database fails, which answers 500 so CoinPay retries.
 */
import type { NextRequest } from 'next/server';
import { verifyCoinPayWebhook } from '@/lib/coinpay-client';
import { handleCoinPayEvent, readCoinPayEvent, supabaseInvoiceStore } from '@/lib/plugin-billing';
import { createAdminSupabase } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const raw = await req.text();
  const sig = req.headers.get('x-coinpay-signature');
  if (!verifyCoinPayWebhook(raw, sig)) {
    return Response.json({ error: 'invalid signature' }, { status: 401 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return Response.json({ error: 'invalid json' }, { status: 400 });
  }

  const ev = readCoinPayEvent(payload);
  try {
    const result = await handleCoinPayEvent(supabaseInvoiceStore(createAdminSupabase()), ev);
    console.log(`[coinpay-webhook] type=${ev.type} status=${ev.status} session=${ev.checkoutSessionId ?? '-'} payment=${ev.paymentId ?? '-'} -> ${result.reason}`);
    return Response.json({ received: true, ...result });
  } catch (e) {
    console.error(`[coinpay-webhook] error: ${(e as Error).message}`);
    return Response.json({ error: 'internal error' }, { status: 500 });
  }
}
