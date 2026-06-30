import { describe, it, expect } from 'vitest';
import { tsp } from '@b1dz/source-strategies';
import { runStrategyBacktest, type FetchCloses } from './strategy-backtest-runner';

const DAY = 24 * 60 * 60 * 1000;

/** Synthetic daily closes within the window: a crash (→ oversold) then a rip. */
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

describe('runStrategyBacktest (bankroll + timeframe)', () => {
  const fetchCloses: FetchCloses = async (_symbol, startMs) => dipAndRip(startMs);

  it('scores both classes over the chosen time frame with a verdict', async () => {
    const plugin = tsp.compile(rsiDip);
    const res = await runStrategyBacktest(plugin, { classes: ['crypto', 'equity'], bankroll: 1000, timeframe: '1 year', fetchCloses });

    expect(res.bankroll).toBe(1000);
    expect(res.timeframe).toBe('1 year');
    expect(res.classes.map((c) => c.assetClass)).toEqual(['crypto', 'equity']);
    for (const c of res.classes) {
      expect(c.symbols.length).toBeGreaterThan(0);
      expect(c.trades).toBeGreaterThanOrEqual(1);
      expect(c.bankroll).toBe(1000);
      expect(Number.isFinite(c.finalEquity)).toBe(true);
      expect(c.profit).toBeCloseTo(c.finalEquity - 1000);
    }
    expect(res.verdict).not.toBeNull();
  });

  it('compounds the bankroll (a winning round-trip ends above starting capital)', async () => {
    // Deterministic: buy the dip below 50, sell the rip above 90 → one big winner.
    const buyLowSellHigh = tsp.compile({
      tsp: '0.1', id: 'bl', name: 'BL',
      definition: { kind: 'rules', rules: [
        { when: { lt: ['price', 50] }, signal: { side: 'buy' } },
        { when: { gt: ['price', 90] }, signal: { side: 'sell' } },
      ] },
    });
    const res = await runStrategyBacktest(buyLowSellHigh, { classes: ['crypto'], bankroll: 1000, timeframe: '1 year', fetchCloses });
    const c = res.classes[0]!;
    expect(c.trades).toBeGreaterThanOrEqual(1);
    expect(c.finalEquity).toBeGreaterThan(1000);
    expect(c.returnPct).toBeGreaterThan(0);
  });

  it('falls back to the default time frame for an unknown label', async () => {
    const plugin = tsp.compile(rsiDip);
    const res = await runStrategyBacktest(plugin, { classes: ['crypto'], bankroll: 500, timeframe: 'forever' as never, fetchCloses });
    expect(res.timeframe).toBe('1 year');
  });

  it('reports a no-data class when every fetch fails (and no verdict)', async () => {
    const empty: FetchCloses = async () => [];
    const plugin = tsp.compile(rsiDip);
    const res = await runStrategyBacktest(plugin, { classes: ['crypto', 'equity'], bankroll: 1000, timeframe: '1 year', fetchCloses: empty });
    for (const c of res.classes) {
      expect(c.symbols).toEqual([]);
      expect(c.trades).toBe(0);
      expect(c.finalEquity).toBe(1000);
    }
    expect(res.verdict).toBeNull();
  });

  it('survives a symbol whose fetch throws', async () => {
    const flaky: FetchCloses = async (symbol, startMs) => {
      if (symbol === 'ETH-USD') throw new Error('boom');
      return dipAndRip(startMs);
    };
    const plugin = tsp.compile(rsiDip);
    const res = await runStrategyBacktest(plugin, { classes: ['crypto'], bankroll: 1000, timeframe: '1 year', fetchCloses: flaky });
    expect(res.classes[0]!.symbols).not.toContain('ETH-USD');
    expect(res.classes[0]!.symbols.length).toBeGreaterThan(0);
  });
});
