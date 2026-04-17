import { describe, expect, it } from 'vitest';
import {
  buildOpportunity,
  buildTriangularOpportunity,
  scoreExecutionMeta,
  type NormalizedQuote,
  type TriangularRoute,
} from './index.js';

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

  it('marks triangular on Base as public with low MEV', () => {
    const meta = scoreExecutionMeta(
      q({ venue: 'uniswap-v3', chain: 'base' }),
      q({ venue: 'uniswap-v3', chain: 'base' }),
      'dex_triangular',
    );
    expect(meta.recommendedExecutionMode).toBe('public');
    expect(meta.requiresPrivateFlow).toBe(false);
    expect(meta.mevRiskScore).toBeLessThan(0.3);
    expect(meta.realizabilityScore).toBeGreaterThan(0.6);
    expect(meta.simulationNotes.some((n) => n.includes('triangular'))).toBe(true);
  });

  it('penalizes triangular on Ethereum mainnet (high MEV)', () => {
    const base = scoreExecutionMeta(
      q({ chain: 'base' }),
      q({ chain: 'base' }),
      'dex_triangular',
    );
    const eth = scoreExecutionMeta(
      q({ chain: 'ethereum' }),
      q({ chain: 'ethereum' }),
      'dex_triangular',
    );
    expect(eth.mevRiskScore).toBeGreaterThan(base.mevRiskScore);
    expect(eth.realizabilityScore).toBeLessThan(base.realizabilityScore);
  });
});

describe('buildTriangularOpportunity', () => {
  function route(amountOut: string): TriangularRoute {
    return {
      chain: 'base',
      venue: 'uniswap-v3',
      hops: [
        { tokenIn: 'USDC', tokenOut: 'WETH', fee: 500 },
        { tokenIn: 'WETH', tokenOut: 'AERO', fee: 3000 },
        { tokenIn: 'AERO', tokenOut: 'USDC', fee: 500 },
      ],
      amountIn: '100',
      amountOut,
      path: '0xdeadbeef',
    };
  }

  it('sets category, route, and synthesizes buy/sell quotes', () => {
    const opp = buildTriangularOpportunity({
      id: 'tri-1',
      sizeUsd: '100',
      route: route('101'),
      amountInUsd: 100,
      amountOutUsd: 101,
      gasUsd: 0.02,
    });
    expect(opp.category).toBe('dex_triangular');
    expect(opp.route).toBeDefined();
    expect(opp.route?.chain).toBe('base');
    expect(opp.buyVenue).toBe('uniswap-v3');
    expect(opp.sellVenue).toBe('uniswap-v3');
    expect(opp.buyChain).toBe('base');
    expect(opp.buyQuote.venueType).toBe('dex');
    expect(opp.sellQuote.venueType).toBe('dex');
    expect(opp.buyQuote.routeHops).toBe(3);
    expect(opp.sellQuote.amountOut).toBe('101');
  });

  it('computes net as gross minus gas minus slippage (150 bps default)', () => {
    const opp = buildTriangularOpportunity({
      id: 'tri-2',
      sizeUsd: '100',
      route: route('101.50'),
      amountInUsd: 100,
      amountOutUsd: 101.5,
      gasUsd: 0.10,
    });
    expect(opp.grossEdgeUsd).toBeCloseTo(1.5, 5);
    expect(opp.totalGasUsd).toBeCloseTo(0.10, 5);
    // slippage: 150 bps of 100 = 1.50
    expect(opp.totalSlippageUsd).toBeCloseTo(1.5, 5);
    // net = 1.5 - 0.10 - 1.5 - 0 = -0.10 → negative
    expect(opp.expectedNetUsd).toBeCloseTo(-0.1, 5);
    expect(opp.executable).toBe(false);
  });

  it('is executable when net clears gas + slippage', () => {
    const opp = buildTriangularOpportunity({
      id: 'tri-3',
      sizeUsd: '100',
      route: route('103'),
      amountInUsd: 100,
      amountOutUsd: 103,
      gasUsd: 0.05,
    });
    // gross=3, slippage=1.5 (150 bps), gas=0.05 → net ≈ 1.45
    expect(opp.expectedNetUsd).toBeGreaterThan(1);
    expect(opp.executable).toBe(true);
    expect(opp.blockers).toHaveLength(0);
  });

  it('flags negative gross edge', () => {
    const opp = buildTriangularOpportunity({
      id: 'tri-4',
      sizeUsd: '100',
      route: route('99'),
      amountInUsd: 100,
      amountOutUsd: 99,
      gasUsd: 0.05,
    });
    expect(opp.grossEdgeUsd).toBeCloseTo(-1, 5);
    expect(opp.blockers).toContain('negative gross edge');
    expect(opp.executable).toBe(false);
  });

  it('honors custom slippageBps and riskBufferUsd', () => {
    const opp = buildTriangularOpportunity({
      id: 'tri-5',
      sizeUsd: '100',
      route: route('103'),
      amountInUsd: 100,
      amountOutUsd: 103,
      gasUsd: 0,
      slippageBps: 0,
      riskBufferUsd: 0.5,
    });
    // gross=3, slippage=0, gas=0, buffer=0.5 → net=2.5
    expect(opp.totalSlippageUsd).toBe(0);
    expect(opp.riskBufferUsd).toBe(0.5);
    expect(opp.expectedNetUsd).toBeCloseTo(2.5, 5);
  });

  it('attaches triangular execution meta', () => {
    const opp = buildTriangularOpportunity({
      id: 'tri-6',
      sizeUsd: '100',
      route: route('103'),
      amountInUsd: 100,
      amountOutUsd: 103,
      gasUsd: 0.05,
    });
    expect(opp.execution?.simulationNotes.some((n) => n.includes('triangular'))).toBe(true);
    expect(opp.execution?.recommendedExecutionMode).toBe('public');
  });
});
