import { describe, it, expect } from 'vitest';
import { tsp } from '@b1dz/source-strategies';
import { runStrategyBacktest, type FetchCloses } from './strategy-backtest-runner';

const DAY = 24 * 60 * 60 * 1000;

/** Synthetic daily closes: a crash (→ oversold) then a rip (→ overbought). */
function dipAndRip(startMs: number): { ts: number; close: number }[] {
  const prices = [
    ...Array.from({ length: 40 }, (_, i) => 100 - i * 1.5),
    ...Array.from({ length: 40 }, (_, i) => 41 + i * 2),
  ];
  return prices.map((close, i) => ({ ts: startMs + i * DAY, close }));
}

const rsiDip = {
  tsp: '0.1',
  id: 'rsi-dip',
  name: 'RSI Dip',
  definition: {
    kind: 'rules',
    indicators: { rsi14: { fn: 'rsi', period: 14 } },
    rules: [
      { when: { lt: ['rsi14', 30] }, signal: { side: 'buy' } },
      { when: { gt: ['rsi14', 70] }, signal: { side: 'sell' } },
    ],
  },
};

describe('runStrategyBacktest', () => {
  const fetchCloses: FetchCloses = async (_symbol, startMs) => dipAndRip(startMs);

  it('scores both asset classes and produces a verdict', async () => {
    const plugin = tsp.compile(rsiDip);
    const res = await runStrategyBacktest(plugin, { classes: ['crypto', 'equity'], amount: 100, fetchCloses });

    expect(res.classes.map((c) => c.assetClass)).toEqual(['crypto', 'equity']);
    for (const c of res.classes) {
      expect(c.horizons).toHaveLength(6); // 1m..5y
      expect(c.symbols.length).toBeGreaterThan(0);
    }
    expect(res.verdict).not.toBeNull();
    expect(['crypto', 'equity']).toContain(res.verdict!.winner);
  });

  it('honors a single-class request and skips the verdict', async () => {
    const plugin = tsp.compile(rsiDip);
    const res = await runStrategyBacktest(plugin, { classes: ['crypto'], amount: 100, fetchCloses });
    expect(res.classes).toHaveLength(1);
    expect(res.classes[0]!.assetClass).toBe('crypto');
    expect(res.verdict).toBeNull();
  });

  it('survives a symbol whose fetch throws', async () => {
    const flaky: FetchCloses = async (symbol, startMs) => {
      if (symbol === 'ETH-USD') throw new Error('boom');
      return dipAndRip(startMs);
    };
    const plugin = tsp.compile(rsiDip);
    const res = await runStrategyBacktest(plugin, { classes: ['crypto'], amount: 100, fetchCloses: flaky });
    expect(res.classes[0]!.symbols).not.toContain('ETH-USD');
    expect(res.classes[0]!.symbols.length).toBeGreaterThan(0);
  });
});
