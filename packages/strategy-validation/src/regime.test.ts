import { describe, it, expect } from 'vitest';
import { snapshotsFrom, trendPrices, randomWalkPrices, syntheticTrades } from './synthetic.js';
import { classifyRegimes, regimeBreakdown, regimeCoverage } from './regime.js';

describe('classifyRegimes', () => {
  it('classifies a persistent uptrend as mostly uptrend', () => {
    const prices = trendPrices({ bars: 500, driftPerBar: 0.002, noise: 0.002, seed: 42 });
    const snaps = snapshotsFrom(prices);
    const regimes = classifyRegimes(snaps);
    expect(regimes.length).toBe(snaps.length);

    const counts: Record<string, number> = {};
    for (const r of regimes) counts[r] = (counts[r] ?? 0) + 1;
    expect(counts.uptrend ?? 0).toBeGreaterThan(counts.downtrend ?? 0);
    expect(counts.downtrend ?? 0).toBeLessThan(50);
  });

  it('classifies a persistent downtrend as mostly downtrend', () => {
    const prices = trendPrices({ bars: 500, driftPerBar: -0.002, noise: 0.002, seed: 7 });
    const snaps = snapshotsFrom(prices);
    const regimes = classifyRegimes(snaps);
    const counts: Record<string, number> = {};
    for (const r of regimes) counts[r] = (counts[r] ?? 0) + 1;
    expect(counts.downtrend ?? 0).toBeGreaterThan(counts.uptrend ?? 0);
  });

  it('classifies a random walk with low vol as mostly ranging', () => {
    const prices = randomWalkPrices({ bars: 500, vol: 0.008, seed: 99 });
    const snaps = snapshotsFrom(prices);
    const regimes = classifyRegimes(snaps);
    const counts: Record<string, number> = {};
    for (const r of regimes) counts[r] = (counts[r] ?? 0) + 1;
    expect(counts.ranging ?? 0).toBeGreaterThan(0);
  });

  it('fills the warmup period with ranging', () => {
    const prices = trendPrices({ bars: 100 });
    const snaps = snapshotsFrom(prices);
    const regimes = classifyRegimes(snaps, { trendPeriod: 50 });
    for (let i = 0; i < 50; i++) {
      expect(regimes[i]).toBe('ranging');
    }
  });

  it('returns all ranging when snapshots are too short', () => {
    const prices = trendPrices({ bars: 30 });
    const snaps = snapshotsFrom(prices);
    const regimes = classifyRegimes(snaps, { trendPeriod: 50 });
    expect(regimes.length).toBe(30);
    for (const r of regimes) expect(r).toBe('ranging');
  });

  it('handles empty snapshots', () => {
    expect(classifyRegimes([])).toEqual([]);
  });
});

describe('regimeBreakdown', () => {
  it('buckets trades by the regime at entry_ts', () => {
    const snaps = snapshotsFrom(trendPrices({ bars: 200, driftPerBar: 0.003, seed: 3 }));
    const regimes = classifyRegimes(snaps);
    const trades = syntheticTrades([0.01, -0.01], {
      startTs: snaps[60]!.ts,
      stepMs: 24 * 60 * 60 * 1000,
    });
    const breakdown = regimeBreakdown(trades, regimes, snaps);
    expect(breakdown.length).toBe(4);
    expect(breakdown.reduce((s, b) => s + b.trades, 0)).toBe(trades.length);
  });

  it('assigns trades with no matching snapshot to ranging', () => {
    const snaps = snapshotsFrom([100, 101]);
    const regimes = ['uptrend', 'uptrend'] as const;
    const trades = syntheticTrades([0.01], { startTs: 999999999999, stepMs: 1000 });
    const breakdown = regimeBreakdown(trades, [...regimes], snaps);
    const ranging = breakdown.find((b) => b.regime === 'ranging')!;
    expect(ranging.trades).toBe(1);
  });

  it('returns all-zero entries for regimes with no trades', () => {
    const snaps = snapshotsFrom([100, 101]);
    const regimes = ['uptrend', 'uptrend'] as const;
    const breakdown = regimeBreakdown([], [...regimes], snaps);
    expect(breakdown.length).toBe(4);
    for (const b of breakdown) {
      expect(b.trades).toBe(0);
      expect(b.netProfit).toBe(0);
    }
  });
});

describe('regimeCoverage', () => {
  it('passes when enough regimes are profitable', () => {
    const breakdown = [
      { regime: 'uptrend' as const, trades: 10, netProfit: 50, returnPct: 0.1, winRate: 0.6 },
      { regime: 'downtrend' as const, trades: 5, netProfit: 10, returnPct: 0.05, winRate: 0.4 },
      { regime: 'ranging' as const, trades: 0, netProfit: 0, returnPct: 0, winRate: 0 },
      { regime: 'volatile' as const, trades: 0, netProfit: 0, returnPct: 0, winRate: 0 },
    ];
    const result = regimeCoverage(breakdown, 2);
    expect(result.passed).toBe(true);
    expect(result.profitableRegimes).toEqual(['uptrend', 'downtrend']);
  });

  it('fails when too few regimes are profitable', () => {
    const breakdown = [
      { regime: 'uptrend' as const, trades: 10, netProfit: 50, returnPct: 0.1, winRate: 0.6 },
      { regime: 'downtrend' as const, trades: 5, netProfit: -20, returnPct: -0.05, winRate: 0.2 },
      { regime: 'ranging' as const, trades: 0, netProfit: 0, returnPct: 0, winRate: 0 },
      { regime: 'volatile' as const, trades: 0, netProfit: 0, returnPct: 0, winRate: 0 },
    ];
    const result = regimeCoverage(breakdown, 2);
    expect(result.passed).toBe(false);
    expect(result.profitableRegimes).toEqual(['uptrend']);
  });

  it('defaults to requiring 2 profitable regimes', () => {
    const breakdown = [
      { regime: 'uptrend' as const, trades: 10, netProfit: 50, returnPct: 0.1, winRate: 0.6 },
      { regime: 'downtrend' as const, trades: 5, netProfit: 10, returnPct: 0.05, winRate: 0.4 },
      { regime: 'ranging' as const, trades: 0, netProfit: 0, returnPct: 0, winRate: 0 },
      { regime: 'volatile' as const, trades: 0, netProfit: 0, returnPct: 0, winRate: 0 },
    ];
    const result = regimeCoverage(breakdown);
    expect(result.passed).toBe(true);
  });

  it('passes even when some regimes show zero returnPct if profitable entries exist', () => {
    // returnPct = 0 means not profitable (because profit > 0 check is on returnPct > 0)
    const breakdown = [
      { regime: 'uptrend' as const, trades: 5, netProfit: 100, returnPct: 0.2, winRate: 0.8 },
      { regime: 'downtrend' as const, trades: 1, netProfit: 0.01, returnPct: 0.001, winRate: 1.0 },
      { regime: 'ranging' as const, trades: 0, netProfit: 0, returnPct: 0, winRate: 0 },
      { regime: 'volatile' as const, trades: 0, netProfit: 0, returnPct: 0, winRate: 0 },
    ];
    const result = regimeCoverage(breakdown, 2);
    expect(result.passed).toBe(true);
    expect(result.profitableRegimes.length).toBe(2);
  });

  it('does not count a regime with trades but zero returnPct as profitable', () => {
    const breakdown = [
      { regime: 'uptrend' as const, trades: 5, netProfit: 100, returnPct: 0.2, winRate: 0.8 },
      { regime: 'downtrend' as const, trades: 5, netProfit: -50, returnPct: -0.1, winRate: 0.2 },
      { regime: 'ranging' as const, trades: 3, netProfit: 0, returnPct: 0, winRate: 0.33 },
      { regime: 'volatile' as const, trades: 0, netProfit: 0, returnPct: 0, winRate: 0 },
    ];
    const result = regimeCoverage(breakdown, 2);
    expect(result.passed).toBe(false);
    expect(result.profitableRegimes).toEqual(['uptrend']);
  });
});
