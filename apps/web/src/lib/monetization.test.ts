import { describe, expect, it, vi } from 'vitest';
import { Credits, memoryStore } from '@profullstack/redeem-credits';
import {
  AGENT_CENTS_UNIT,
  FREE_WATERMARK,
  PRODUCT_KIND,
  PRO_DAYS_UNIT,
  analystAllowance,
  isAdminUser,
  monetizationConfig,
  productById,
  proUntilFromLedger,
  resolveEntitlement,
  testVerdict,
  usageCostUsd,
  watermark,
  worstCaseCostUsd,
} from './monetization';
import { handleCoinPayEvent, settleInvoice, type InvoiceRow, type InvoiceStore } from './plugin-billing';
import { chargeAgent, settleAfter, type PayConfig, type PayStore } from './agent-pay';
import { computeMetrics } from './metrics';
import { brokerLinks } from './referrals';
import { fetchCoinpayClaims } from './coinpay-signin';

const DAY = 86_400_000;
const LAUNCH = Date.parse('2026-11-25T00:00:00Z');
const cfg = monetizationConfig();

describe('pro days -> Pro until', () => {
  it('starts old grants at launch, stacks grants, restarts after a lapse', () => {
    const oct = Date.parse('2026-10-26T00:00:00Z');
    expect(proUntilFromLedger([{ amount: 7, kind: 'grant', at: oct }], LAUNCH)).toBe(LAUNCH + 7 * DAY);
    const a = LAUNCH + DAY;
    // 30 then 365 while active: stacked
    expect(proUntilFromLedger([{ amount: 30, kind: 'grant', at: a }, { amount: 365, kind: 'grant', at: a + DAY }], LAUNCH)).toBe(a + 395 * DAY);
    // second grant after the first lapsed: starts fresh
    const late = a + 40 * DAY;
    expect(proUntilFromLedger([{ amount: 30, kind: 'grant', at: a }, { amount: 30, kind: 'grant', at: late }], LAUNCH)).toBe(late + 30 * DAY);
    expect(proUntilFromLedger([], LAUNCH)).toBe(0);
  });
});

describe('Profullstack Pass maps onto Pro', () => {
  const now = LAUNCH + 10 * DAY;
  it('an active pass is Pro until it expires', () => {
    const e = resolveEntitlement({ proUntil: 0, pass: { active: true, expiresAt: now + 5 * DAY } }, now);
    expect(e).toMatchObject({ tier: 'pro', via: 'pass', passUntil: now + 5 * DAY });
  });
  it('an expired or inactive pass is not', () => {
    expect(resolveEntitlement({ proUntil: 0, pass: { active: true, expiresAt: now - 1 } }, now).tier).toBe('free');
    expect(resolveEntitlement({ proUntil: 0, pass: { active: false, expiresAt: now + DAY } }, now).tier).toBe('free');
    expect(resolveEntitlement({ proUntil: 0, pass: null }, now).tier).toBe('free');
  });
  it('pro days win and the pass is still reported', () => {
    expect(resolveEntitlement({ proUntil: now + DAY, pass: { active: true, expiresAt: now + 9 * DAY } }, now)).toMatchObject({ tier: 'pro', via: 'pro_days', passUntil: now + 9 * DAY });
  });
  it('the CoinPay sign-in reads the pass claim from userinfo (bound by sub)', async () => {
    const ccfg = { clientId: 'cid', clientSecret: 'secret', base: 'https://coinpay.test', siteUrl: 'https://b1dz.test' };
    const expires = new Date(Date.now() + 20 * DAY).toISOString();
    const fake = (async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/api/oauth/token')) {
        const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
        return Response.json({ access_token: 'at', id_token: [b64({ alg: 'RS256' }), b64({ iss: ccfg.base, aud: 'cid', sub: 's', exp: Math.floor(Date.now() / 1000) + 300, nonce: 'n' }), 'x'].join('.') });
      }
      return Response.json({ sub: 's', email: 'x@example.com', pass: { active: true, expires_at: expires } });
    }) as typeof fetch;
    const r = await fetchCoinpayClaims(ccfg, { code: 'c', verifier: 'v'.repeat(43), nonce: 'n' }, fake);
    expect(r.ok && r.claims.pass?.active).toBe(true);
    expect(r.ok && r.claims.pass?.expiresAt?.toISOString()).toBe(expires);
  });
});

describe('analyst allowance and caps', () => {
  const base = { monthCostUsd: 0, todayQueries: 0, freeGlobalMonthCostUsd: 0, nextCostUsd: 0.1 };
  it('Pro is refused once this month would pass the $8 cap', () => {
    expect(analystAllowance({ ...base, tier: 'pro', monthCostUsd: 7.5 }, cfg).ok).toBe(true);
    const r = analystAllowance({ ...base, tier: 'pro', monthCostUsd: 7.95 }, cfg);
    expect(r).toMatchObject({ ok: false, reason: 'pro_cap', status: 429 });
    expect(!r.ok && r.message).toMatch(/resets on the 1st/);
    expect(cfg.proMonthlyCapUsd).toBe(8);
  });
  it('free: 5 a day, then a per-user monthly cap, then the site-wide pool', () => {
    expect(analystAllowance({ ...base, tier: 'free', todayQueries: 4 }, cfg).ok).toBe(true);
    expect(analystAllowance({ ...base, tier: 'free', todayQueries: 5 }, cfg)).toMatchObject({ ok: false, reason: 'free_daily' });
    expect(analystAllowance({ ...base, tier: 'free', monthCostUsd: cfg.freeMonthlyCapUsd }, cfg)).toMatchObject({ ok: false, reason: 'free_cap' });
    expect(analystAllowance({ ...base, tier: 'free', freeGlobalMonthCostUsd: cfg.freeGlobalMonthlyCapUsd }, cfg)).toMatchObject({ ok: false, reason: 'free_pool' });
  });
  it('every free answer carries the watermark', () => {
    expect(watermark('Rates are up.')).toBe(`Rates are up.\n\n— ${FREE_WATERMARK}`);
    expect(FREE_WATERMARK).toContain('b1dz.com/pricing');
  });
  it('prices calls from the usage block and bounds the worst case', () => {
    expect(usageCostUsd('claude-opus-5-5', { input_tokens: 1_000_000, output_tokens: 1_000_000 })).toBeCloseTo(24);
    expect(usageCostUsd('claude-opus-5-5', { cache_read_input_tokens: 1_000_000 })).toBeCloseTo(0.4);
    expect(usageCostUsd('claude-opus-6', { input_tokens: 1_000_000 })).toBeCloseTo(5); // unknown Opus: never under-priced
    expect(worstCaseCostUsd('claude-opus-5-5', 25_000, 6000)).toBeCloseTo((10_000 * 4 + 6000 * 20) / 1e6);
  });
  it('prices are env-configurable', () => {
    vi.stubEnv('AGENT_CARD_PRICE_USD', '0.05');
    vi.stubEnv('PRO_AI_MONTHLY_CAP_USD', '6');
    expect(monetizationConfig()).toMatchObject({ cardPriceUsd: 0.05, proMonthlyCapUsd: 6, analystPriceUsd: 0.35, pro30PriceUsd: 25, pro365PriceUsd: 199 });
    vi.unstubAllEnvs();
  });
});

// ── CoinPay webhook: Pro passes credit pro_days once ───────────────────────

function fakeInvoices(credits: Credits, invoices: InvoiceRow[]): InvoiceStore & { granted: string[] } {
  const rows = new Map(invoices.map((i) => [i.id, { ...i }]));
  const granted: string[] = [];
  return {
    granted,
    findBySessionId: async (id) => [...rows.values()].find((r) => r.metadata?.checkout_session_id === id) ?? null,
    findById: async (id) => rows.get(id) ?? null,
    findByPaymentId: async () => null,
    claimPaid: async (id, updates) => {
      const r = rows.get(id)!;
      if (r.paid_at) return false;
      Object.assign(r, updates);
      return true;
    },
    update: async (id, updates) => void Object.assign(rows.get(id)!, updates),
    getInstall: async () => null,
    upsertInstall: async () => {
      throw new Error('a product must never become a plugin install');
    },
    grantCredit: async (userId, unit, amount, source) => {
      if ((await credits.history(userId, unit)).some((e) => e.source === source)) return false;
      await credits.grant(userId, { unit, amount }, source);
      granted.push(source);
      return true;
    },
  };
}

describe('Pro checkout settlement', () => {
  const user = '11111111-1111-1111-1111-111111111111';
  const inv = (id: string, product: string): InvoiceRow => ({
    id,
    user_id: user,
    plugin_id: productById(product)!.invoiceKey,
    paid_at: null,
    status: 'pending',
    metadata: { b1dz_kind: PRODUCT_KIND, checkout_session_id: `cs_${id}` },
  });

  it('a 30-day pass adds 30 pro_days exactly once across webhook replays and the poller', async () => {
    const credits = new Credits(memoryStore());
    const store = fakeInvoices(credits, [inv('aaaaaaaa-0000-0000-0000-000000000001', 'pro-30')]);
    const ev = { type: 'payment.confirmed', status: 'confirmed', paymentId: 'pay_1', checkoutSessionId: 'cs_aaaaaaaa-0000-0000-0000-000000000001', accountId: user, metadata: {} };
    const first = await handleCoinPayEvent(store, ev);
    expect(first).toMatchObject({ settled: true, reason: 'granted 30 pro_days' });
    expect(await handleCoinPayEvent(store, ev)).toMatchObject({ settled: false, reason: 'already paid' });
    expect(await handleCoinPayEvent(store, { ...ev, type: 'payment.forwarded', status: 'forwarded' })).toMatchObject({ settled: false });
    // the invoice poller racing the webhook
    await settleInvoice(store, (await store.findById('aaaaaaaa-0000-0000-0000-000000000001'))!, { paymentId: 'pay_1', forwarded: false });
    expect(await credits.balance(user, PRO_DAYS_UNIT)).toBe(30);
    expect(store.granted).toEqual(['coinpay:aaaaaaaa-0000-0000-0000-000000000001']);
  });

  it('even a second claim on the same invoice cannot grant twice (ledger source guard)', async () => {
    const credits = new Credits(memoryStore());
    const store = fakeInvoices(credits, [inv('aaaaaaaa-0000-0000-0000-000000000002', 'pro-365')]);
    const row = (await store.findById('aaaaaaaa-0000-0000-0000-000000000002'))!;
    await settleInvoice(store, row, { paymentId: 'p', forwarded: false });
    // Force a re-claim (e.g. paid_at cleared by hand): the ledger guard still holds.
    await store.update(row.id, { paid_at: null });
    const again = await settleInvoice(store, row, { paymentId: 'p', forwarded: false });
    expect(again.reason).toBe('already granted');
    expect(await credits.balance(user, PRO_DAYS_UNIT)).toBe(365);
  });

  it('agent credit lands as cents', async () => {
    const credits = new Credits(memoryStore());
    const store = fakeInvoices(credits, [inv('aaaaaaaa-0000-0000-0000-000000000003', 'agent-credit-10')]);
    await settleInvoice(store, (await store.findById('aaaaaaaa-0000-0000-0000-000000000003'))!, { paymentId: 'p', forwarded: false });
    expect(await credits.balance(user, AGENT_CENTS_UNIT)).toBe(1000);
  });
});

// ── Agents pay per call ────────────────────────────────────────────────────

function fakePay(credits: Credits): PayStore & { rows: Array<Record<string, unknown> & { id: number }> } {
  const rows: Array<Record<string, unknown> & { id: number }> = [];
  return {
    rows,
    insertCharge: async (row) => {
      if (row.x402_nonce && rows.some((r) => r.x402_nonce === row.x402_nonce)) throw new Error('duplicate key');
      const id = rows.length + 1;
      rows.push({ ...row, id, delivered: false });
      return id;
    },
    chargeByNonce: async (n) => {
      const r = rows.find((x) => x.x402_nonce === n);
      return r ? { id: r.id, resource: String(r.resource), delivered: !!r.delivered } : null;
    },
    claimRetry: async (id) => {
      const r = rows.find((x) => x.id === id)!;
      if (r.delivered) return false;
      r.delivered = true;
      return true;
    },
    markDelivered: async (id) => void (rows.find((x) => x.id === id)!.delivered = true),
    markUndelivered: async (id) => void (rows.find((x) => x.id === id)!.delivered = false),
    spendCents: async (u, c, note) => (await credits.balance(u, AGENT_CENTS_UNIT)) >= c && (await credits.spend(u, AGENT_CENTS_UNIT, c, note)).ok,
    refundCents: async (u, c, source) => credits.grant(u, { unit: AGENT_CENTS_UNIT, amount: c }, source),
    balanceCents: (u) => credits.balance(u, AGENT_CENTS_UNIT),
  };
}

const payCfg: PayConfig = { apiKey: 'cp_live_test', payTo: '0x1111111111111111111111111111111111111111', baseUrl: 'https://coinpay.test', siteUrl: 'https://b1dz.test' };
const card = { resource: 'research/card/equities.risk-stats', priceUsd: 0.03, description: 'b1dz research card equities.risk-stats' };
const proof = (nonce: string) =>
  Buffer.from(JSON.stringify({ x402Version: 2, scheme: 'exact', network: 'eip155:8453', payload: { authorization: { nonce } } })).toString('base64');

describe('agent charges', () => {
  it('no payment and no credit: 402 with an x402 offer for $0.03 in USDC', async () => {
    const r = await chargeAgent({ headers: new Headers() }, card, { userId: 'u1', agentTokenId: 't1' }, fakePay(new Credits(memoryStore())), payCfg);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(402);
    expect(r.headers['payment-required']).toBeTruthy();
    const accepts = r.body.accepts as { amount: string; payTo: string; network: string }[];
    expect(accepts[0]).toMatchObject({ amount: '30000', payTo: payCfg.payTo, network: 'eip155:8453' });
  });

  it('draws from prepaid credit, and refunds a failed call', async () => {
    const credits = new Credits(memoryStore());
    await credits.grant('u1', { unit: AGENT_CENTS_UNIT, amount: 100 }, 'coinpay:x');
    const store = fakePay(credits);
    const payer = { userId: 'u1', agentTokenId: 't1' };
    const r = await chargeAgent({ headers: new Headers() }, card, payer, store, payCfg);
    expect(r).toMatchObject({ ok: true, method: 'prepaid' });
    expect(await credits.balance('u1', AGENT_CENTS_UNIT)).toBe(97);
    if (r.ok) await settleAfter(store, r, payer, card, false);
    expect(await credits.balance('u1', AGENT_CENTS_UNIT)).toBe(100);
  });

  it('x402: settles once, records the nonce, honours one retry of a failed call, never a second', async () => {
    const store = fakePay(new Credits(memoryStore()));
    const settle = vi.fn()
      .mockResolvedValueOnce({ ok: true, payer: '0xabc', ref: 'n1', txHash: '0xtx', network: 'eip155:8453' })
      .mockResolvedValue({ ok: false, reason: 'proof already used', replay: true });
    const req = { headers: new Headers({ 'payment-signature': proof('n1') }) };
    const payer = { userId: null, agentTokenId: null };
    const first = await chargeAgent(req, card, payer, store, payCfg, settle);
    expect(first).toMatchObject({ ok: true, method: 'x402' });
    expect(store.rows[0]).toMatchObject({ x402_nonce: 'n1', amount_usd: 0.03, method: 'x402' });
    if (first.ok) await settleAfter(store, first, payer, card, false); // the card failed
    expect(await chargeAgent(req, card, payer, store, payCfg, settle)).toMatchObject({ ok: true, method: 'retry' });
    expect(await chargeAgent(req, card, payer, store, payCfg, settle)).toMatchObject({ ok: false, status: 402 });
    // a proof for one resource never pays for another
    expect(await chargeAgent(req, { ...card, resource: 'research/analyst' }, payer, store, payCfg, settle)).toMatchObject({ ok: false });
  });
});

// ── 60-day test numbers ────────────────────────────────────────────────────

describe('admin metrics', () => {
  it('cost per non-paying user, renewals and red flags', () => {
    const since = Date.parse('2026-11-01T00:00:00Z');
    const m = computeMetrics({
      since,
      usage: [
        { user_id: 'f1', tier: 'free', cost_usd: 4 },
        { user_id: 'f1', tier: 'free', cost_usd: 4 },
        { user_id: 'f2', tier: 'free', cost_usd: 1 },
        { user_id: 'p1', tier: 'pro', cost_usd: 3 },
        { user_id: null, tier: 'agent', cost_usd: 0.1 },
      ],
      invoices: [
        { user_id: 'p1', plugin_id: 'b1dz:pro-30', amount_usd: 25, paid_at: '2026-10-20T00:00:00Z' },
        { user_id: 'p1', plugin_id: 'b1dz:pro-30', amount_usd: 25, paid_at: '2026-11-19T00:00:00Z' },
        { user_id: 'p2', plugin_id: 'b1dz:pro-365', amount_usd: 199, paid_at: '2026-11-20T00:00:00Z' },
        { user_id: 'p3', plugin_id: 'b1dz:agent-credit-10', amount_usd: 10, paid_at: '2026-11-21T00:00:00Z' },
      ],
      charges: [{ method: 'x402', amount_usd: 0.35 }, { method: 'prepaid', amount_usd: 0.03 }],
    });
    expect(m).toMatchObject({ freeActiveUsers: 2, renewals: 1, proRevenueUsd: 224, proBuyers: 2, agentCreditRevenueUsd: 10, x402RevenueUsd: 0.35 });
    const v = testVerdict(m, { ...cfg, serverMonthlyUsd: 40 });
    expect(v.costPerFreeUser).toBeCloseTo(4.5);
    expect(v.freeCostRed).toBe(false);
    expect(testVerdict({ ...m, freeAiCostUsd: 12 }, cfg).freeCostRed).toBe(true);
    expect(testVerdict({ ...m, proRevenueUsd: 10 }, cfg).revenueRed).toBe(true);
  });

  it('admin is an explicit user id list', () => {
    vi.stubEnv('B1DZ_ADMIN_USER_IDS', 'AAA, bbb');
    expect(isAdminUser('aaa')).toBe(true);
    expect(isAdminUser('ccc')).toBe(false);
    expect(isAdminUser(null)).toBe(false);
    vi.unstubAllEnvs();
  });
});

describe('broker referral links', () => {
  it('plain links by default, an https referral when configured, never a non-https one', () => {
    const plain = brokerLinks(undefined);
    expect(plain.find((b) => b.id === 'alpaca')).toMatchObject({ url: 'https://alpaca.markets/', referral: false });
    const withRef = brokerLinks(JSON.stringify({ alpaca: 'https://alpaca.markets/?ref=x', kraken: 'javascript:alert(1)' }));
    expect(withRef.find((b) => b.id === 'alpaca')).toMatchObject({ url: 'https://alpaca.markets/?ref=x', referral: true });
    expect(withRef.find((b) => b.id === 'kraken')).toMatchObject({ referral: false });
    expect(brokerLinks('not json').length).toBe(plain.length);
  });
});
