/**
 * CoinPay merchant integration wrapper.
 *
 * Wraps the @profullstack/coinpay SDK and provides a few helpers tied to
 * b1dz's plugin marketplace: invoice creation, status fetch, webhook
 * signature verification.
 *
 * Env vars (all optional — if missing, free-plugin path still works):
 *   - COINPAY_API_KEY        (e.g. cp_live_xxxxx)
 *   - COINPAY_BUSINESS_ID    (uuid of the b1dz business in CoinPay)
 *   - COINPAY_WEBHOOK_SECRET (HMAC secret configured in CoinPay dashboard)
 *   - COINPAY_BASE_URL       (default https://coinpayportal.com/api)
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createAdminSupabase } from './supabase';

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

export const SUPPORTED_BLOCKCHAINS = [
  'BTC', 'BCH', 'ETH', 'POL', 'SOL',
  'USDC_ETH', 'USDC_POL', 'USDC_BASE', 'USDC_SOL',
] as const;
export type SupportedBlockchain = typeof SUPPORTED_BLOCKCHAINS[number];

export function isSupportedBlockchain(value: unknown): value is SupportedBlockchain {
  return typeof value === 'string' && (SUPPORTED_BLOCKCHAINS as readonly string[]).includes(value);
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

interface CreateInvoiceResult {
  invoiceId: string;
  paymentAddress: string | null;
  qrCode: string | null;
  cryptoAmount: string | null;
  blockchain: string;
  amountUsd: number;
  expiresAt: string | null;
  coinpayPaymentId: string;
}

/**
 * Create a Coinpay payment for a plugin subscription and persist the
 * invoice row. Uses the user-RLS-scoped Supabase client passed in (the
 * insert lives under the authenticated user's RLS policies).
 */
export async function createInvoiceForPlugin(opts: {
  userId: string;
  pluginId: string;
  amountUsd: number;
  blockchain: SupportedBlockchain;
  description?: string;
  /** Pass the per-user Supabase client from authenticate(req).client */
  client: ReturnType<typeof createAdminSupabase>;
}): Promise<CreateInvoiceResult> {
  if (!coinpayConfigured()) {
    throw new Error('Coinpay not configured (COINPAY_API_KEY / COINPAY_BUSINESS_ID missing)');
  }
  const apiKey = process.env.COINPAY_API_KEY!;
  const businessId = process.env.COINPAY_BUSINESS_ID!;
  const baseUrl = coinpayBaseUrl();

  const description = opts.description ?? `b1dz plugin: ${opts.pluginId}`;
  const metadata = {
    user_id: opts.userId,
    plugin_id: opts.pluginId,
    b1dz_kind: 'plugin_subscription' as const,
  };

  const res = await fetch(`${baseUrl}/payments/create`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      business_id: businessId,
      amount: opts.amountUsd,
      currency: 'USD',
      blockchain: opts.blockchain,
      description,
      metadata,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`coinpay create payment ${res.status}: ${text.slice(0, 200)}`);
  }
  const body = (await res.json()) as CoinPayPaymentResponse;
  const payment = body.payment;
  if (!payment) {
    throw new Error(`coinpay returned no payment object: ${body.error ?? 'unknown'}`);
  }

  // Insert invoice row scoped to the user.
  const { data, error } = await (opts.client as unknown as {
    from: (t: string) => {
      insert: (r: Record<string, unknown>) => {
        select: (s: string) => {
          single: () => Promise<{ data: { id: string } | null; error: { message: string } | null }>;
        };
      };
    };
  }).from('plugin_invoices').insert({
    user_id: opts.userId,
    plugin_id: opts.pluginId,
    coinpay_payment_id: payment.id,
    amount_usd: opts.amountUsd,
    blockchain: opts.blockchain,
    payment_address: payment.payment_address ?? null,
    crypto_amount: payment.crypto_amount != null ? String(payment.crypto_amount) : null,
    qr_code: payment.qr_code ?? null,
    status: payment.status ?? 'pending',
    expires_at: payment.expires_at ?? null,
    metadata,
  }).select('id').single();
  if (error || !data) throw new Error(`insert invoice: ${error?.message ?? 'no row returned'}`);

  return {
    invoiceId: data.id,
    paymentAddress: payment.payment_address ?? null,
    qrCode: payment.qr_code ?? null,
    cryptoAmount: payment.crypto_amount != null ? String(payment.crypto_amount) : null,
    blockchain: opts.blockchain,
    amountUsd: opts.amountUsd,
    expiresAt: payment.expires_at ?? null,
    coinpayPaymentId: payment.id,
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
