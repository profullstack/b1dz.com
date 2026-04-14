import { describe, expect, it } from 'vitest';
import { buildOpportunity, type NormalizedQuote } from './index.js';

function makeQuote(overrides: Partial<NormalizedQuote>): NormalizedQuote {
  return {
    venue: 'test',
    venueType: 'aggregator',
    chain: null,
    pair: 'ETH-USDC',
    baseAsset: 'ETH',
    quoteAsset: 'USDC',
    amountIn: '1',
    amountOut: '2500',
    amountInUsd: 2500,
    amountOutUsd: 2500,
    side: 'buy',
    estimatedUnitPrice: '2500',
    feeUsd: 0,
    gasUsd: 0,
    slippageBps: 0,
    priceImpactBps: null,
    routeHops: 1,
    routeSummary: [],
    quoteTimestamp: 0,
    raw: null,
    ...overrides,
  };
}

describe('buildOpportunity', () => {
  it('flags negative gross edge as blocker and marks non-executable', () => {
    const buy = makeQuote({ venue: 'a', amountInUsd: 2500, amountOutUsd: 2500 });
    const sell = makeQuote({ venue: 'b', amountInUsd: 2500, amountOutUsd: 2490 }); // sell got back less
    const opp = buildOpportunity('id-1', '1000', buy, sell, 'cex_dex');
    expect(opp.grossEdgeUsd).toBe(-10);
    expect(opp.blockers).toContain('negative gross edge');
    expect(opp.executable).toBe(false);
  });

  it('computes net as gross minus fees minus gas minus slippage minus buffer', () => {
    const buy = makeQuote({ venue: 'a', amountInUsd: 1000, amountOutUsd: 1000, feeUsd: 2, gasUsd: 1, slippageBps: 10 });
    const sell = makeQuote({ venue: 'b', amountInUsd: 1000, amountOutUsd: 1020, feeUsd: 3, gasUsd: 2, slippageBps: 20 });
    const opp = buildOpportunity('id-2', '1000', buy, sell, 'cex_dex', { riskBufferUsd: 1 });
    expect(opp.grossEdgeUsd).toBe(20);
    expect(opp.totalFeesUsd).toBe(5);
    expect(opp.totalGasUsd).toBe(3);
    // slippage = (10+20)/10000 * 1000 = 3
    expect(opp.totalSlippageUsd).toBeCloseTo(3, 5);
    // net = 20 - 5 - 3 - 3 - 1 = 8
    expect(opp.expectedNetUsd).toBeCloseTo(8, 5);
    expect(opp.expectedNetBps).toBeCloseTo(80, 5);
    expect(opp.executable).toBe(true);
  });

  it('flags negative net even when gross is positive', () => {
    const buy = makeQuote({ venue: 'a', amountInUsd: 1000, amountOutUsd: 1000, feeUsd: 10, gasUsd: 5 });
    const sell = makeQuote({ venue: 'b', amountInUsd: 1000, amountOutUsd: 1005, feeUsd: 10, gasUsd: 5 });
    const opp = buildOpportunity('id-3', '1000', buy, sell, 'cex_dex');
    expect(opp.grossEdgeUsd).toBe(5);
    expect(opp.expectedNetUsd).toBeLessThan(0);
    expect(opp.blockers).toContain('negative net after costs');
    expect(opp.executable).toBe(false);
  });

  it('preserves the underlying quotes for audit', () => {
    const buy = makeQuote({ venue: 'a' });
    const sell = makeQuote({ venue: 'b' });
    const opp = buildOpportunity('id-4', '100', buy, sell, 'dex_dex');
    expect(opp.buyQuote).toBe(buy);
    expect(opp.sellQuote).toBe(sell);
    expect(opp.buyVenue).toBe('a');
    expect(opp.sellVenue).toBe('b');
  });
});
