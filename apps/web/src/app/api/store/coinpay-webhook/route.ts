/**
 * POST /api/store/coinpay-webhook
 *
 * Public endpoint — verified solely by HMAC. Reads raw body, verifies the
 * X-CoinPay-Signature header, then updates plugin_invoices + extends
 * user_installed_plugins.paid_until on payment.confirmed (or .forwarded —
 * whichever fires first; we treat both as activation triggers and dedupe
 * via the invoice's already-set paid_at column).
 *
 * payment.expired / payment.failed → invoice row status only.
 *
 * Uses service-role client because the request is webhook-signed, not
 * user-authed. Stamps user_id from the payment metadata for accountability.
 *
 * Always returns 200 on a verified event (Coinpay retries on non-2xx, and
 * we want duplicate deliveries to be a no-op).
 */
import type { NextRequest } from 'next/server';
import { verifyCoinPayWebhook } from '@/lib/coinpay-client';
import { createAdminSupabase } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

const SUBSCRIPTION_DAYS = 30;

interface WebhookEnvelope {
  event?: string;
  data?: {
    payment_id?: string;
    payment?: {
      id?: string;
      status?: string;
      metadata?: Record<string, unknown>;
    };
    metadata?: Record<string, unknown>;
  };
}

interface InvoiceRow {
  id: string;
  user_id: string;
  plugin_id: string;
  paid_at: string | null;
  metadata: Record<string, unknown> | null;
}

export async function POST(req: NextRequest) {
  const raw = await req.text();
  const sig = req.headers.get('x-coinpay-signature');
  if (!verifyCoinPayWebhook(raw, sig)) {
    return Response.json({ error: 'invalid signature' }, { status: 401 });
  }

  let envelope: WebhookEnvelope;
  try {
    envelope = JSON.parse(raw) as WebhookEnvelope;
  } catch {
    return Response.json({ error: 'invalid json' }, { status: 400 });
  }

  const event = envelope.event ?? '';
  const paymentId = envelope.data?.payment?.id ?? envelope.data?.payment_id ?? '';
  if (!paymentId) {
    console.log(`[coinpay-webhook] event=${event} skipped: no payment id`);
    return Response.json({ received: true });
  }

  const admin = createAdminSupabase();
  const adminClient = admin as unknown as {
    from: (t: string) => {
      select: (s: string) => {
        eq: (c: string, v: string) => {
          maybeSingle: () => Promise<{ data: InvoiceRow | null; error: { message: string } | null }>;
        };
      };
      update: (r: Record<string, unknown>) => {
        eq: (c: string, v: string) => Promise<{ error: { message: string } | null }>;
      };
      upsert: (r: Record<string, unknown>, opts: { onConflict: string }) => Promise<{ error: { message: string } | null }>;
    };
  };

  const lookup = await adminClient.from('plugin_invoices')
    .select('id, user_id, plugin_id, paid_at, metadata')
    .eq('coinpay_payment_id', paymentId)
    .maybeSingle();
  if (lookup.error) {
    console.error(`[coinpay-webhook] lookup failed: ${lookup.error.message}`);
    return Response.json({ received: true });
  }
  const invoice = lookup.data;
  if (!invoice) {
    console.log(`[coinpay-webhook] event=${event} payment=${paymentId} no matching invoice row`);
    return Response.json({ received: true });
  }

  const now = new Date().toISOString();
  const isActivation = event === 'payment.confirmed' || event === 'payment.forwarded';
  const isFailed = event === 'payment.expired' || event === 'payment.failed';

  if (isActivation) {
    const updates: Record<string, unknown> = {
      status: event === 'payment.forwarded' ? 'forwarded' : 'confirmed',
      updated_at: now,
    };
    if (event === 'payment.confirmed' && !invoice.paid_at) updates.paid_at = now;
    if (event === 'payment.forwarded') {
      updates.forwarded_at = now;
      if (!invoice.paid_at) updates.paid_at = now;
    }
    const upd = await adminClient.from('plugin_invoices').update(updates).eq('id', invoice.id);
    if (upd.error) console.error(`[coinpay-webhook] invoice update: ${upd.error.message}`);

    // Skip extending paid_until twice for the same invoice.
    if (invoice.paid_at) {
      console.log(`[coinpay-webhook] event=${event} invoice=${invoice.id} dedup (already paid)`);
      return Response.json({ received: true });
    }

    // Look up existing install row to compute new paid_until.
    const existing = await (adminClient as unknown as {
      from: (t: string) => {
        select: (s: string) => {
          eq: (c: string, v: string) => {
            eq: (c2: string, v2: string) => {
              maybeSingle: () => Promise<{ data: { paid_until: string | null; version: string } | null; error: { message: string } | null }>;
            };
          };
        };
      };
    }).from('user_installed_plugins')
      .select('paid_until, version')
      .eq('user_id', invoice.user_id)
      .eq('plugin_id', invoice.plugin_id)
      .maybeSingle();

    const baseMs = existing.data?.paid_until && new Date(existing.data.paid_until).getTime() > Date.now()
      ? new Date(existing.data.paid_until).getTime()
      : Date.now();
    const newPaidUntil = new Date(baseMs + SUBSCRIPTION_DAYS * 86_400_000).toISOString();
    const version = existing.data?.version ?? '0.0.0';

    const upsert = await adminClient.from('user_installed_plugins').upsert({
      user_id: invoice.user_id,
      plugin_id: invoice.plugin_id,
      version,
      status: 'active',
      paid_until: newPaidUntil,
      updated_at: now,
    }, { onConflict: 'user_id,plugin_id' });
    if (upsert.error) console.error(`[coinpay-webhook] install upsert: ${upsert.error.message}`);
    console.log(`[coinpay-webhook] event=${event} user=${invoice.user_id.slice(0, 8)} plugin=${invoice.plugin_id} paid_until=${newPaidUntil}`);
    return Response.json({ received: true });
  }

  if (isFailed) {
    const upd = await adminClient.from('plugin_invoices').update({
      status: event === 'payment.expired' ? 'expired' : 'failed',
      updated_at: now,
    }).eq('id', invoice.id);
    if (upd.error) console.error(`[coinpay-webhook] failed-update: ${upd.error.message}`);
    return Response.json({ received: true });
  }

  // Other events (created/detected/etc.) — log and ack.
  console.log(`[coinpay-webhook] event=${event} payment=${paymentId} (no-op)`);
  return Response.json({ received: true });
}
