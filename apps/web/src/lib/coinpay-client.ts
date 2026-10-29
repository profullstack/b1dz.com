/**
 * CoinPay merchant integration wrapper.
 *
 * Helpers for b1dz's plugin marketplace: hosted checkout sessions
 * (POST /api/checkout/sessions, buyer picks any coin or PayPal on CoinPay),
 * legacy payment status fetch, webhook signature verification.
 *
 * Env vars (all optional — if missing, free-plugin path still works):
 *   - COINPAY_API_KEY        (e.g. cp_live_xxxxx)
 *   - COINPAY_BUSINESS_ID    (uuid of the b1dz business in CoinPay)
 *   - COINPAY_WEBHOOK_SECRET (HMAC secret configured in CoinPay dashboard)
 *   - COINPAY_BASE_URL       (default https://coinpayportal.com/api)
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export interface CipherInvoice {
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

interface CoinPayPaymentResponse {
  success?: boolean;
  payment?: {
    id: string;
    business_id: string;
    amount: number;
    currency: string;
    blockchain: string;
    crypto_amount?: string | number;
    payment_address?: string;
    qr_code?: string;
    status: string;
    expires_at?: string;
    created_at?: string;
    metadata?: Record<string, unknown>;
  };
  error?: string;
}

export function coinpayConfigured(): boolean {
  return !!(process.env.COINPAY_API_KEY && process.env.COINPAY_BUSINESS_ID);
}

function coinpayBaseUrl(): string {
  return process.env.COINPAY_BASE_URL ?? 'https://coinpayportal.com/api';
}

/**
 * HMAC-SHA256(timestamp + '.' + raw_payload, COINPAY_WEBHOOK_SECRET).
 * Header format: `t=<timestamp>,v1=<hex>`. Reject if |now - timestamp| > 300.
 * Timing-safe compare. Matches the algorithm in /home/ubuntu/src/coinpayportal/docs/API.md.
 */
export function verifyCoinPayWebhook(rawBody: string, signatureHeader: string | null | undefined): boolean {
  const secret = process.env.COINPAY_WEBHOOK_SECRET;
  if (!secret) return false;
  if (!signatureHeader || typeof signatureHeader !== 'string') return false;

  const parts: Record<string, string> = {};
  for (const piece of signatureHeader.split(',')) {
    const idx = piece.indexOf('=');
    if (idx <= 0) continue;
    parts[piece.slice(0, idx).trim()] = piece.slice(idx + 1).trim();
  }
  const timestamp = parts.t;
  const provided = parts.v1;
  if (!timestamp || !provided) return false;

  const ts = Number.parseInt(timestamp, 10);
  if (!Number.isFinite(ts)) return false;
  const ageSec = Math.abs(Math.floor(Date.now() / 1000) - ts);
  if (ageSec > 300) return false;

  const expected = createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex');

  let providedBuf: Buffer;
  let expectedBuf: Buffer;
  try {
    providedBuf = Buffer.from(provided, 'hex');
    expectedBuf = Buffer.from(expected, 'hex');
  } catch {
    return false;
  }
  if (providedBuf.length === 0 || providedBuf.length !== expectedBuf.length) return false;
  try {
    return timingSafeEqual(providedBuf, expectedBuf);
  } catch {
    return false;
  }
}

/** Every CoinPay checkout from this site carries this as its property. */
export const PAYMENT_PROPERTY = 'b1dz.com';

/** Invoices opened as a hosted checkout session store this as their blockchain (the buyer picks later). */
export const CHECKOUT_BLOCKCHAIN = 'CHECKOUT';

export const CHECKOUT_WINDOW_MINUTES = 60;

function siteUrl(): string {
  return (process.env.NEXT_PUBLIC_SITE_URL || 'https://b1dz.com').replace(/\/+$/, '');
}

export interface CheckoutSessionInput {
  invoiceId: string;
  userId: string;
  email: string;
  pluginId: string;
  amountUsd: number;
  description: string;
  kind: 'install' | 'renew';
  siteUrl?: string;
}

/**
 * The POST /api/checkout/sessions body. The buyer's email is the CoinPay
 * customer, the b1dz user id is the account, and our invoice id rides in
 * metadata so the webhook can settle by it as well as by the session id.
 */
export function buildCheckoutSessionBody(input: CheckoutSessionInput): Record<string, unknown> {
  const base = (input.siteUrl ?? siteUrl()).replace(/\/+$/, '');
  return {
    amount: input.amountUsd,
    currency: 'USD',
    description: input.description,
    customer_email: input.email,
    account_id: input.userId,
    property: PAYMENT_PROPERTY,
    metadata: {
      invoice_id: input.invoiceId,
      user_id: input.userId,
      plugin_id: input.pluginId,
      b1dz_kind: 'plugin_subscription',
      b1dz_action: input.kind,
    },
    success_url: `${base}/store/invoice/${input.invoiceId}?session={CHECKOUT_SESSION_ID}`,
    cancel_url: `${base}/store`,
    expires_in_minutes: CHECKOUT_WINDOW_MINUTES,
  };
}

interface CheckoutSessionCreated {
  id: string;
  url: string;
  expiresAt: string | null;
}

/** Open a CoinPay hosted checkout session; the buyer picks any coin or PayPal there. */
export async function createCheckoutSession(
  input: CheckoutSessionInput,
  fetchImpl: typeof fetch = fetch,
): Promise<CheckoutSessionCreated> {
  if (!coinpayConfigured()) throw new Error('Coinpay not configured (COINPAY_API_KEY / COINPAY_BUSINESS_ID missing)');
  const baseUrl = coinpayBaseUrl().replace(/\/+$/, '');
  const res = await fetchImpl(`${baseUrl}/checkout/sessions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${process.env.COINPAY_API_KEY!}`,
      'idempotency-key': `b1dz-invoice-${input.invoiceId}`,
    },
    body: JSON.stringify(buildCheckoutSessionBody(input)),
  });
  const body = (await res.json().catch(() => ({}))) as { id?: string; url?: string; expires_at?: string; error?: string; code?: string };
  if (!res.ok || !body.id || !body.url) {
    throw new Error(`coinpay checkout session ${res.status}: ${(body.code ? `${body.code} ` : '') + (body.error ?? '')}`.trim());
  }
  // Only ever send buyers to CoinPay's own origin.
  const origin = new URL(baseUrl).origin;
  const u = new URL(body.url, origin);
  if (u.origin !== origin) throw new Error('coinpay checkout session returned a foreign url');
  return { id: body.id, url: u.toString(), expiresAt: body.expires_at ?? null };
}

export interface CheckoutSessionStatus {
  status: string;
  paymentId: string | null;
  paidMethod: string | null;
}

/** GET /api/checkout/sessions/:id with the business key (owner view). */
export async function fetchCheckoutSession(sessionId: string, fetchImpl: typeof fetch = fetch): Promise<CheckoutSessionStatus | null> {
  if (!coinpayConfigured()) return null;
  const baseUrl = coinpayBaseUrl().replace(/\/+$/, '');
  const res = await fetchImpl(`${baseUrl}/checkout/sessions/${encodeURIComponent(sessionId)}`, {
    headers: { authorization: `Bearer ${process.env.COINPAY_API_KEY!}` },
    cache: 'no-store',
  });
  if (!res.ok) return null;
  const body = (await res.json().catch(() => ({}))) as {
    session?: { status?: string; payment_id?: string | null; paid_reference?: string | null; paypal_transaction_id?: string | null; paid_method?: string | null };
  };
  if (!body.session?.status) return null;
  const s = body.session;
  return {
    status: s.status!,
    paymentId: s.paid_reference ?? s.payment_id ?? s.paypal_transaction_id ?? null,
    paidMethod: s.paid_method ?? null,
  };
}

interface CreateInvoiceResult {
  invoiceId: string;
  checkoutSessionId: string;
  checkoutUrl: string;
  amountUsd: number;
  expiresAt: string | null;
}

type InvoiceClient = {
  from: (t: string) => {
    insert: (r: Record<string, unknown>) => {
      select: (s: string) => {
        single: () => Promise<{ data: { id: string } | null; error: { message: string } | null }>;
      };
    };
    update: (r: Record<string, unknown>) => {
      eq: (c: string, v: string) => Promise<{ error: { message: string } | null }>;
    };
  };
};

/**
 * Open a hosted CoinPay checkout for a plugin subscription. The invoice row
 * is written first (so its id can travel in the session metadata), then the
 * session id and url are stored on it. Uses the user-RLS-scoped client.
 */
export async function createCheckoutForPlugin(opts: {
  userId: string;
  email: string;
  pluginId: string;
  amountUsd: number;
  description: string;
  kind: 'install' | 'renew';
  client: unknown;
}, fetchImpl: typeof fetch = fetch): Promise<CreateInvoiceResult> {
  if (!coinpayConfigured()) {
    throw new Error('Coinpay not configured (COINPAY_API_KEY / COINPAY_BUSINESS_ID missing)');
  }
  const db = opts.client as InvoiceClient;
  const baseMeta = {
    user_id: opts.userId,
    plugin_id: opts.pluginId,
    b1dz_kind: 'plugin_subscription' as const,
    b1dz_action: opts.kind,
  };
  const { data, error } = await db.from('plugin_invoices').insert({
    user_id: opts.userId,
    plugin_id: opts.pluginId,
    amount_usd: opts.amountUsd,
    blockchain: CHECKOUT_BLOCKCHAIN,
    status: 'pending',
    metadata: baseMeta,
  }).select('id').single();
  if (error || !data) throw new Error(`insert invoice: ${error?.message ?? 'no row returned'}`);

  let session: CheckoutSessionCreated;
  try {
    session = await createCheckoutSession({
      invoiceId: data.id,
      userId: opts.userId,
      email: opts.email,
      pluginId: opts.pluginId,
      amountUsd: opts.amountUsd,
      description: opts.description,
      kind: opts.kind,
    }, fetchImpl);
  } catch (e) {
    await db.from('plugin_invoices').update({ status: 'failed', updated_at: new Date().toISOString() }).eq('id', data.id);
    throw e;
  }

  const upd = await db.from('plugin_invoices').update({
    expires_at: session.expiresAt,
    metadata: { ...baseMeta, checkout_session_id: session.id, checkout_url: session.url },
    updated_at: new Date().toISOString(),
  }).eq('id', data.id);
  if (upd.error) throw new Error(`store checkout session: ${upd.error.message}`);

  return {
    invoiceId: data.id,
    checkoutSessionId: session.id,
    checkoutUrl: session.url,
    amountUsd: opts.amountUsd,
    expiresAt: session.expiresAt,
  };
}

/**
 * Fetch latest payment status from Coinpay (used by the invoice page poller).
 */
export async function fetchCoinPayPaymentStatus(coinpayPaymentId: string): Promise<{ status: string; raw: CoinPayPaymentResponse['payment'] | null }> {
  if (!coinpayConfigured()) return { status: 'unconfigured', raw: null };
  const apiKey = process.env.COINPAY_API_KEY!;
  const baseUrl = coinpayBaseUrl();
  const res = await fetch(`${baseUrl}/payments/${encodeURIComponent(coinpayPaymentId)}`, {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) return { status: 'unknown', raw: null };
  const body = (await res.json()) as CoinPayPaymentResponse;
  return { status: body.payment?.status ?? 'unknown', raw: body.payment ?? null };
}
