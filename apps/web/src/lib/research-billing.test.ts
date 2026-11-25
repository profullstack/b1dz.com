import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Credits, memoryStore } from '@profullstack/redeem-credits';

// Analyst bookkeeping is mocked: these tests are about who pays and what they get.
const usage = { monthCostUsd: 0, todayQueries: 0 };
let tier: 'pro' | 'free' = 'free';
const recorded: Array<{ tier: string; costUsd: number }> = [];
vi.mock('./supabase', () => ({ createAdminSupabase: () => ({}) }));
vi.mock('./entitlements', () => ({
  getEntitlement: async () => ({ tier, via: tier === 'pro' ? 'pro_days' : null, proUntil: null, passUntil: null }),
  userUsage: async () => ({ ...usage }),
  freeGlobalMonthCost: async () => 0,
  recordUsage: async (_db: unknown, r: { tier: string; costUsd: number }) => void recorded.push(r),
}));
vi.mock('@b1dz/ai-analyzer', () => ({ resolveAnthropicModel: async () => 'claude-opus-5-5' }));

import { askAnalystFor, runCardFor, setPayStoreForTest } from './research-billing';
import { AGENT_CENTS_UNIT, FREE_WATERMARK } from './monetization';
import type { PayStore } from './agent-pay';

function memPay(credits: Credits): PayStore {
  let n = 0;
  return {
    insertCharge: async () => ++n,
    chargeByNonce: async () => null,
    claimRetry: async () => false,
    markDelivered: async () => undefined,
    markUndelivered: async () => undefined,
    spendCents: async (u, c, note) => (await credits.balance(u, AGENT_CENTS_UNIT)) >= c && (await credits.spend(u, AGENT_CENTS_UNIT, c, note)).ok,
    refundCents: async (u, c, s) => credits.grant(u, { unit: AGENT_CENTS_UNIT, amount: c }, s),
    balanceCents: (u) => credits.balance(u, AGENT_CENTS_UNIT),
  };
}

const ran: string[] = [];
const run = async (id: string) => {
  ran.push(id);
  return { status: 200, body: { id, title: id, source: 'x', params: {}, blocks: [] } } as never;
};
const noHeaders = { headers: new Headers() };
const agent = { kind: 'agent' as const, userId: 'u1', agentTokenId: 't1' };

let credits: Credits;
beforeEach(() => {
  ran.length = 0;
  recorded.length = 0;
  credits = new Credits(memoryStore());
  setPayStoreForTest(memPay(credits));
  vi.stubEnv('CRAWL_PAY_TO', '0x1111111111111111111111111111111111111111');
  vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test');
});

describe('research card metering', () => {
  it('people at /terminal never pay, metered card or not', async () => {
    const r = await runCardFor({ kind: 'user', userId: 'u1' }, noHeaders, 'equities.risk-stats', {}, run);
    expect(r.status).toBe(200);
    expect(ran).toEqual(['equities.risk-stats']);
  });

  it('an agent gets raw quote cards free and unmetered', async () => {
    for (const id of ['overview.chart', 'equities.price-history', 'derivatives.options-chain', 'crypto.price-compare']) {
      const r = await runCardFor(agent, noHeaders, id, {}, run);
      expect(r.status, id).toBe(200);
      expect(r.headers['x-b1dz-charged']).toBeUndefined();
    }
  });

  it('an agent without credit or payment gets 402 for a metered card, and the card never runs', async () => {
    for (const id of ['equities.risk-stats', 'credit.oas-ratings', 'energy.crude-spot']) {
      const r = await runCardFor(agent, noHeaders, id, {}, run);
      expect(r.status, id).toBe(402);
      expect((r.body as { price_usd: number }).price_usd).toBe(0.03);
    }
    expect(ran).toEqual([]);
  });

  it('prepaid credit pays for a metered card', async () => {
    await credits.grant('u1', { unit: AGENT_CENTS_UNIT, amount: 10 }, 'coinpay:t');
    const r = await runCardFor(agent, noHeaders, 'credit.oas-ratings', {}, run);
    expect(r.status).toBe(200);
    expect(r.headers['x-b1dz-charged']).toBe('0.03 prepaid');
    expect(await credits.balance('u1', AGENT_CENTS_UNIT)).toBe(7);
  });

  it('no credential: free cards are 401, metered cards are for sale by x402', async () => {
    expect((await runCardFor({ kind: 'anon' }, noHeaders, 'overview.chart', {}, run)).status).toBe(401);
    const r = await runCardFor({ kind: 'anon' }, noHeaders, 'equities.risk-stats', {}, run);
    expect(r.status).toBe(402);
    expect(r.headers['payment-required']).toBeTruthy();
  });
});

describe('AI analyst', () => {
  const answerFetch = (async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ model: 'claude-opus-5-5', content: [{ type: 'text', text: 'The curve is steepening.' }], usage: { input_tokens: 2000, output_tokens: 500 } }),
  })) as never;
  const deps = { search: async () => [], runCard: async (id: string) => ({ id, title: id, source: 'FRED', text: 'rows' }) };

  it('a free answer carries the watermark and records its real cost', async () => {
    tier = 'free';
    const r = await askAnalystFor({ kind: 'user', userId: 'u1' }, noHeaders, { question: 'curve?' }, { fetchImpl: answerFetch, deps });
    expect(r.status).toBe(200);
    expect((r.body as { answer: string }).answer).toContain(FREE_WATERMARK);
    expect(recorded[0]).toMatchObject({ tier: 'free' });
    expect(recorded[0].costUsd).toBeCloseTo((2000 * 4 + 500 * 20) / 1e6);
  });

  it('the sixth free question of the day is refused before the model is called', async () => {
    tier = 'free';
    usage.todayQueries = 5;
    const fetchImpl = vi.fn(answerFetch);
    const r = await askAnalystFor({ kind: 'user', userId: 'u1' }, noHeaders, { question: 'again?' }, { fetchImpl: fetchImpl as never, deps });
    expect(r.status).toBe(429);
    expect(fetchImpl).not.toHaveBeenCalled();
    usage.todayQueries = 0;
  });

  it('Pro answers have no watermark and stop at the monthly cap', async () => {
    tier = 'pro';
    const ok = await askAnalystFor({ kind: 'user', userId: 'u1' }, noHeaders, { question: 'curve?' }, { fetchImpl: answerFetch, deps });
    expect((ok.body as { answer: string }).answer).toBe('The curve is steepening.');
    usage.monthCostUsd = 7.99;
    const capped = await askAnalystFor({ kind: 'user', userId: 'u1' }, noHeaders, { question: 'curve?' }, { fetchImpl: answerFetch, deps });
    expect(capped.status).toBe(429);
    expect((capped.body as { reason: string }).reason).toBe('pro_cap');
    usage.monthCostUsd = 0;
  });

  it('agents pay $0.35 a query: 402 without credit, charged with it', async () => {
    const r = await askAnalystFor(agent, noHeaders, { question: 'curve?' }, { fetchImpl: answerFetch, deps });
    expect(r.status).toBe(402);
    expect((r.body as { price_usd: number }).price_usd).toBe(0.35);
    await credits.grant('u1', { unit: AGENT_CENTS_UNIT, amount: 100 }, 'coinpay:t');
    const paid = await askAnalystFor(agent, noHeaders, { question: 'curve?' }, { fetchImpl: answerFetch, deps });
    expect(paid.status).toBe(200);
    expect((paid.body as { answer: string }).answer).not.toContain(FREE_WATERMARK);
    expect(await credits.balance('u1', AGENT_CENTS_UNIT)).toBe(65);
    expect(recorded.at(-1)).toMatchObject({ tier: 'agent' });
  });
});
