import { describe, expect, it } from 'vitest';
import type { NormalizedQuote } from '@b1dz/venue-types';
import { rankCrossVenueOpportunities } from './index.js';

function mkQuote(overrides: Partial<NormalizedQuote>): NormalizedQuote {
  return {
    venue: 'test',
    venueType: 'cex',
    chain: null,
    pair: 'ETH-USDC',
    baseAsset: 'ETH',
    quoteAsset: 'USDC',
    amountIn: '1000',
    amountOut: '0.4',
    amountInUsd: null,
    amountOutUsd: null,
    side: 'buy',
    estimatedUnitPrice: '2500',
    feeUsd: 0,
    gasUsd: 0,
    slippageBps: 0,
    priceImpactBps: null,
    routeHops: 1,
    routeSummary: [],
    quoteTimestamp: Date.now(),
    expiresAt: null,
    latencyMs: 0,
    allowanceRequired: false,
    approvalToken: null,
    tokenLifecycle: null,
    raw: null,
    ...overrides,
  };
}

describe('rankCrossVenueOpportunities', () => {
  it('enumerates every (buy, sell) pair with matching base asset', () => {
    const buys = [
      mkQuote({ venue: 'kraken', side: 'buy', amountIn: '1000', amountOut: '0.4' }),
      mkQuote({ venue: '0x', side: 'buy', amountIn: '1000', amountOut: '0.401' }),
    ];
    const sells = [
      mkQuote({ venue: 'coinbase', side: 'sell', amountIn: '0.4', amountOut: '1002' }),
      mkQuote({ venue: 'jupiter', side: 'sell', amountIn: '0.4', amountOut: '1005' }),
    ];
    const opps = rankCrossVenueOpportunities(buys, sells, { tradeSizeUsd: 1000 });
    // 2 buys × 2 sells = 4 combos
    expect(opps).toHaveLength(4);
  });

  it('sorts by expectedNetUsd descending', () => {
    const buys = [
      mkQuote({ venue: 'low', side: 'buy', amountIn: '1000', amountOut: '0.40' }),
      mkQuote({ venue: 'high', side: 'buy', amountIn: '1000', amountOut: '0.402' }),
    ];
    const sells = [
      mkQuote({ venue: 'sell', side: 'sell', amountIn: '0.4', amountOut: '1010' }),
    ];
    const opps = rankCrossVenueOpportunities(buys, sells, { tradeSizeUsd: 1000 });
    // Higher amountOut (more ETH for same USD) should produce higher net.
    expect(opps[0]?.buyVenue).toBe('high');
  });

  it('marks negative-edge routes as non-executable', () => {
    const buys = [mkQuote({ venue: 'a', side: 'buy', amountIn: '1000', amountOut: '0.4' })];
    const sells = [mkQuote({ venue: 'b', side: 'sell', amountIn: '0.4', amountOut: '990' })];
    const opps = rankCrossVenueOpportunities(buys, sells, { tradeSizeUsd: 1000 });
    expect(opps[0]?.executable).toBe(false);
    expect(opps[0]?.blockers).toContain('negative gross edge');
  });

  it('subtracts fees, gas, slippage, and risk buffer from net', () => {
    const buys = [
      mkQuote({
        venue: 'a',
        side: 'buy',
        amountIn: '1000',
        amountOut: '0.4',
        feeUsd: 2,
        gasUsd: 1,
        slippageBps: 5,
      }),
    ];
    const sells = [
      mkQuote({
        venue: 'b',
        side: 'sell',
        amountIn: '0.4',
        amountOut: '1020',
        feeUsd: 3,
        gasUsd: 2,
        slippageBps: 5,
      }),
    ];
    const opps = rankCrossVenueOpportunities(buys, sells, {
      tradeSizeUsd: 1000,
      riskBufferUsd: 1,
    });
    expect(opps).toHaveLength(1);
    // gross = 1020 - 1000 = 20
    // fees = 2+3 = 5; gas = 1+2 = 3; slip = (5+5)/10000 * 1000 = 1; buf = 1
    // net = 20 - 5 - 3 - 1 - 1 = 10
    expect(opps[0]!.grossEdgeUsd).toBe(20);
    expect(opps[0]!.expectedNetUsd).toBeCloseTo(10, 5);
    expect(opps[0]!.executable).toBe(true);
  });

  it('rejects routes that fail minNetUsd', () => {
    const buys = [mkQuote({ venue: 'a', side: 'buy', amountIn: '1000', amountOut: '0.4' })];
    const sells = [mkQuote({ venue: 'b', side: 'sell', amountIn: '0.4', amountOut: '1001' })];
    const opps = rankCrossVenueOpportunities(buys, sells, {
      tradeSizeUsd: 1000,
      minNetUsd: 5,
    });
    expect(opps[0]?.executable).toBe(false);
    expect(opps[0]?.blockers.join(' ')).toMatch(/min 5/);
  });

  it('flags stale quotes', () => {
    const old = Date.now() - 30_000;
    const buys = [mkQuote({ venue: 'a', side: 'buy', amountIn: '1000', amountOut: '0.4', quoteTimestamp: old })];
    const sells = [mkQuote({ venue: 'b', side: 'sell', amountIn: '0.4', amountOut: '1010' })];
    const opps = rankCrossVenueOpportunities(buys, sells, { tradeSizeUsd: 1000 });
    expect(opps[0]?.blockers.some((b) => b.startsWith('stale'))).toBe(true);
  });

  it('assigns cex_cex / cex_dex / dex_dex categories correctly', () => {
    const cexBuy = mkQuote({ venue: 'kraken', venueType: 'cex', side: 'buy', amountIn: '1000', amountOut: '0.4' });
    const cexSell = mkQuote({ venue: 'coinbase', venueType: 'cex', side: 'sell', amountIn: '0.4', amountOut: '1010' });
    const dexSell = mkQuote({ venue: 'jupiter', venueType: 'aggregator', chain: 'solana', side: 'sell', amountIn: '0.4', amountOut: '1010' });

    const cexCex = rankCrossVenueOpportunities([cexBuy], [cexSell], { tradeSizeUsd: 1000 });
    const cexDex = rankCrossVenueOpportunities([cexBuy], [dexSell], { tradeSizeUsd: 1000 });
    expect(cexCex[0]?.category).toBe('cex_cex');
    expect(cexDex[0]?.category).toBe('cex_dex');
  });

  it('ignores same-venue self-matches', () => {
    const q = mkQuote({ venue: 'kraken', side: 'buy' });
    const q2 = { ...q, side: 'sell' as const, amountIn: '0.4', amountOut: '1010' };
    const opps = rankCrossVenueOpportunities([q], [q2], { tradeSizeUsd: 1000 });
    expect(opps).toHaveLength(0);
  });
});
