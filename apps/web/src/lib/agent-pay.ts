/**
 * Agents pay per call (b1dz monetization, 2026-11-25).
 *
 * A metered research card ($0.03) or an AI analyst query ($0.35), asked for
 * by an agent (b1dz_agent_ key, MCP OAuth token, or nobody at all), is paid
 * one of two ways, checked in this order:
 *
 *   1. x402: the request carries a proof (PAYMENT-SIGNATURE or X-PAYMENT).
 *      CoinPay verifies and settles it (USDC on Base, Polygon or Ethereum,
 *      straight to CRAWL_PAY_TO). The proof's nonce is recorded once; if the
 *      call then fails, the same proof may be presented again for the same
 *      resource and is honoured once without a second charge.
 *   2. Prepaid: the token's owner bought agent credit through CoinPay
 *      (credit_ledger unit agent_cents) and it covers the price.
 *
 * Otherwise the answer is HTTP 402 with an x402 offer (body and the spec's
 * PAYMENT-REQUIRED header) and a pointer to prepaid credit. Signed-in people
 * never come through here: /terminal stays free.
 */
import {
  buildOffer,
  decodePayment,
  expectedFor,
  paymentRequiredHeader,
  paymentResponseHeader,
  verifyAndSettle,
} from '@profullstack/x402-gateway';
import { AGENT_CENTS_UNIT } from './monetization';

export interface Charge {
  resource: string;
  priceUsd: number;
  description: string;
}

export interface Payer {
  userId: string | null;
  agentTokenId: string | null;
}

export interface ChargeRow {
  id: number;
  resource: string;
  delivered: boolean;
}

export interface PayStore {
  insertCharge(row: {
    user_id: string | null;
    agent_token_id: string | null;
    resource: string;
    method: 'x402' | 'prepaid';
    amount_usd: number;
    x402_nonce?: string | null;
    x402_tx?: string | null;
    payer?: string | null;
    network?: string | null;
  }): Promise<number>;
  chargeByNonce(nonce: string): Promise<ChargeRow | null>;
  /** Claim an undelivered charge (true once). */
  claimRetry(id: number): Promise<boolean>;
  markDelivered(id: number): Promise<void>;
  markUndelivered(id: number): Promise<void>;
  spendCents(userId: string, cents: number, note: string): Promise<boolean>;
  refundCents(userId: string, cents: number, source: string): Promise<void>;
  balanceCents(userId: string): Promise<number>;
}

export type Settle = typeof verifyAndSettle;

export interface PayConfig {
  apiKey?: string;
  payTo?: string;
  baseUrl: string;
  siteUrl: string;
}

export function payConfig(): PayConfig {
  const env = (n: string) => {
    const v = (process.env as Record<string, string | undefined>)[n];
    return v && v.trim() ? v.trim() : undefined;
  };
  return {
    apiKey: env('COINPAY_X402_KEY'),
    payTo: env('CRAWL_PAY_TO'),
    baseUrl: (env('COINPAY_X402_BASE_URL') ?? 'https://coinpayportal.com').replace(/\/+$/, ''),
    siteUrl: (env('NEXT_PUBLIC_SITE_URL') ?? 'https://b1dz.com').replace(/\/+$/, ''),
  };
}

export type PayResult =
  | { ok: true; method: 'x402' | 'prepaid' | 'retry'; chargeId: number | null; headers: Record<string, string> }
  | { ok: false; status: number; body: Record<string, unknown>; headers: Record<string, string> };

export const cents = (usd: number) => Math.round(usd * 100);

function offerFor(cfg: PayConfig, charge: Charge) {
  if (!cfg.payTo) return null;
  return buildOffer({
    payTo: cfg.payTo,
    priceCents: Math.round(charge.priceUsd * 100 * 1e4) / 1e4,
    resource: `${cfg.siteUrl}/${charge.resource.replace(/^\/+/, '')}`,
    description: charge.description,
  });
}

/** The 402: an x402 offer when payment is configured, and the prepaid route either way. */
export function paymentRequired(cfg: PayConfig, charge: Charge, payer: Payer, reason?: string): PayResult {
  const offer = offerFor(cfg, charge);
  const headers: Record<string, string> = { 'cache-control': 'no-store' };
  if (offer) headers['payment-required'] = paymentRequiredHeader(offer, { description: charge.description, ...(reason ? { error: reason } : {}) });
  return {
    ok: false,
    status: 402,
    headers,
    body: {
      error: reason ?? `payment required: ${charge.description} costs $${charge.priceUsd.toFixed(2)} USDC`,
      price_usd: charge.priceUsd,
      resource: charge.resource,
      pay: {
        x402: offer ? 'retry this request with a PAYMENT-SIGNATURE (or X-PAYMENT) header for one of the offers below' : 'x402 is not configured on this server',
        prepaid: payer.userId
          ? 'or buy agent credit for this account at https://b1dz.com/pricing; calls are then drawn from it'
          : 'or use a b1dz_agent_ token whose account holds agent credit (https://b1dz.com/pricing)',
        pricing: 'https://b1dz.com/pricing',
      },
      ...(offer ?? {}),
    },
  };
}

function proofHeader(headers: Headers): string | null {
  return headers.get('payment-signature') ?? headers.get('x-payment');
}

function nonceOf(payment: Record<string, unknown> | null): string | null {
  const p = payment?.payload as { authorization?: { nonce?: unknown }; blockHash?: unknown } | undefined;
  const n = p?.authorization?.nonce ?? p?.blockHash;
  return typeof n === 'string' && n ? n.slice(0, 200) : null;
}

/**
 * Take payment for one call, before it runs. On ok, call delivered() or
 * failed() with the chargeId after the work, so a failed call can be retried
 * (x402) or refunded (prepaid).
 */
export async function chargeAgent(
  req: { headers: Headers },
  charge: Charge,
  payer: Payer,
  store: PayStore,
  cfg: PayConfig = payConfig(),
  settle: Settle = verifyAndSettle,
): Promise<PayResult> {
  const header = proofHeader(req.headers);
  if (header) {
    const offer = offerFor(cfg, charge);
    if (!offer || !cfg.apiKey) return paymentRequired(cfg, charge, payer, 'x402 is not configured on this server');
    const payment = decodePayment(header);
    if (!payment) return paymentRequired(cfg, charge, payer, 'the payment header is not base64 JSON');
    const expected = expectedFor(payment, offer);
    if (!expected) return paymentRequired(cfg, charge, payer, 'the payment is not for one of the offered networks');
    const nonce = nonceOf(payment);
    const r = await settle(payment, expected, {
      apiKey: cfg.apiKey,
      baseUrl: cfg.baseUrl,
      metadata: { property: 'b1dz.com', resource_path: `/${charge.resource}`, source: 'x402', user_id: payer.userId },
    });
    if (!r.ok) {
      if (r.replay && nonce) {
        const prior = await store.chargeByNonce(nonce);
        if (prior && prior.resource === charge.resource && !prior.delivered && (await store.claimRetry(prior.id))) {
          return { ok: true, method: 'retry', chargeId: prior.id, headers: {} };
        }
      }
      return paymentRequired(cfg, charge, payer, `payment refused: ${r.reason}`);
    }
    const id = await store.insertCharge({
      user_id: payer.userId,
      agent_token_id: payer.agentTokenId,
      resource: charge.resource,
      method: 'x402',
      amount_usd: charge.priceUsd,
      x402_nonce: nonce,
      x402_tx: r.txHash,
      payer: r.payer,
      network: r.network,
    });
    return { ok: true, method: 'x402', chargeId: id, headers: { 'payment-response': paymentResponseHeader({ transaction: r.txHash, network: r.network, payer: r.payer }) } };
  }

  if (payer.userId) {
    const price = cents(charge.priceUsd);
    if (price > 0 && (await store.spendCents(payer.userId, price, charge.resource))) {
      const id = await store.insertCharge({
        user_id: payer.userId,
        agent_token_id: payer.agentTokenId,
        resource: charge.resource,
        method: 'prepaid',
        amount_usd: charge.priceUsd,
      });
      return { ok: true, method: 'prepaid', chargeId: id, headers: {} };
    }
  }
  return paymentRequired(cfg, charge, payer);
}

/** After the work: keep the charge, or make it good (prepaid refund, x402 retry allowed). */
export async function settleAfter(store: PayStore, result: Extract<PayResult, { ok: true }>, payer: Payer, charge: Charge, delivered: boolean) {
  if (result.chargeId == null) return;
  if (delivered) return store.markDelivered(result.chargeId);
  if (result.method === 'prepaid' && payer.userId) {
    await store.refundCents(payer.userId, cents(charge.priceUsd), `refund:charge:${result.chargeId}`);
  }
  await store.markUndelivered(result.chargeId);
}

// ── Supabase store ─────────────────────────────────────────────────────────

type Db = { from: (t: string) => any }; // eslint-disable-line @typescript-eslint/no-explicit-any
type CreditsLike = {
  spend(userId: string, unit: string, amount: number, note?: string): Promise<{ ok: boolean; balance: number }>;
  grant(userId: string, g: { unit: string; amount: number }, source?: string): Promise<void>;
  balance(userId: string, unit: string): Promise<number>;
};

export function supabasePayStore(db: Db, credits: CreditsLike): PayStore {
  return {
    async insertCharge(row) {
      const { data, error } = await db.from('agent_charges').insert(row).select('id').single();
      if (error) throw new Error(`agent_charges insert: ${error.message}`);
      return Number((data as { id: number }).id);
    },
    async chargeByNonce(nonce) {
      const { data } = await db.from('agent_charges').select('id, resource, delivered').eq('x402_nonce', nonce).maybeSingle();
      return (data as ChargeRow | null) ?? null;
    },
    async claimRetry(id) {
      const { data } = await db.from('agent_charges').update({ delivered: true }).eq('id', id).eq('delivered', false).select('id');
      return Array.isArray(data) && data.length > 0;
    },
    async markDelivered(id) {
      await db.from('agent_charges').update({ delivered: true }).eq('id', id);
    },
    async markUndelivered(id) {
      await db.from('agent_charges').update({ delivered: false }).eq('id', id);
    },
    async spendCents(userId, c, note) {
      try {
        if ((await credits.balance(userId, AGENT_CENTS_UNIT)) < c) return false;
        return (await credits.spend(userId, AGENT_CENTS_UNIT, c, note)).ok;
      } catch {
        return false;
      }
    },
    async refundCents(userId, c, source) {
      await credits.grant(userId, { unit: AGENT_CENTS_UNIT, amount: c }, source).catch(() => undefined);
    },
    balanceCents: (userId) => credits.balance(userId, AGENT_CENTS_UNIT),
  };
}
