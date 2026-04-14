import { describe, expect, it } from 'vitest';
import { buildOpportunity, scoreExecutionMeta, type NormalizedQuote } from './index.js';

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

  it('attaches execution meta with a recommended mode', () => {
    const buy = makeQuote({ venue: 'a', venueType: 'cex' });
    const sell = makeQuote({ venue: 'b', venueType: 'cex' });
    const opp = buildOpportunity('id-5', '100', buy, sell, 'cex_cex');
    expect(opp.execution).toBeDefined();
    expect(opp.execution?.recommendedExecutionMode).toBe('public');
    expect(opp.execution?.mevRiskScore).toBeLessThan(0.2);
  });
});

describe('scoreExecutionMeta', () => {
  function q(overrides: Partial<NormalizedQuote>): NormalizedQuote {
    return {
      venue: 'v',
      venueType: 'dex',
      chain: 'base',
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

  it('pushes dex↔dex on ethereum mainnet to private flow', () => {
    const meta = scoreExecutionMeta(
      q({ venue: 'uniswap', chain: 'ethereum' }),
      q({ venue: 'curve', chain: 'ethereum' }),
      'dex_dex',
    );
    expect(meta.recommendedExecutionMode).toBe('private');
    expect(meta.requiresPrivateFlow).toBe(true);
    expect(meta.mevRiskScore).toBeGreaterThan(0.7);
    expect(meta.realizabilityScore).toBeLessThan(0.5);
  });

  it('keeps dex↔dex on L2s in public mode with moderate MEV', () => {
    const meta = scoreExecutionMeta(
      q({ venue: 'uniswap', chain: 'base' }),
      q({ venue: 'aerodrome', chain: 'base' }),
      'dex_dex',
    );
    expect(meta.recommendedExecutionMode).toBe('public');
    expect(meta.requiresPrivateFlow).toBe(false);
    expect(meta.mevRiskScore).toBeLessThan(0.6);
  });

  it('marks pump.fun scalp as paper_only', () => {
    const meta = scoreExecutionMeta(
      q({ venueType: 'launchpad', chain: 'solana' }),
      q({ venueType: 'dex', chain: 'solana' }),
      'pumpfun_scalp',
    );
    expect(meta.recommendedExecutionMode).toBe('paper_only');
  });

  it('collapses realizability when a quote is expired', () => {
    const meta = scoreExecutionMeta(
      q({ expiresAt: Date.now() - 1_000 }),
      q({}),
      'dex_dex',
    );
    expect(meta.realizabilityScore).toBeLessThan(0.1);
    expect(meta.simulationNotes.some((n) => n.includes('expired'))).toBe(true);
  });

  it('penalizes complex multi-hop routes', () => {
    const easy = scoreExecutionMeta(q({ routeHops: 1 }), q({ routeHops: 1 }), 'dex_dex');
    const hard = scoreExecutionMeta(q({ routeHops: 3 }), q({ routeHops: 3 }), 'dex_dex');
    expect(hard.realizabilityScore).toBeLessThan(easy.realizabilityScore);
    expect(hard.latencyRiskScore).toBeGreaterThan(easy.latencyRiskScore);
  });
});
