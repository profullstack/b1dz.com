import { describe, it, expect } from 'vitest';
import { tsp, ZERO_COST_MODEL, DEFAULT_COST_MODEL, EQUITY_COST_MODEL, type CostModel } from '@b1dz/source-strategies';
import { runStrategyBacktest, DEFAULT_CLASS_COSTS, type FetchCloses } from './strategy-backtest-runner';

const DAY = 24 * 60 * 60 * 1000;

/** Synthetic daily closes within the window: a crash (→ oversold) then a rip. */
function dipAndRip(startMs: number): { ts: number; close: number }[] {
  const prices = [
    ...Array.from({ length: 40 }, (_, i) => 100 - i * 1.5),
    ...Array.from({ length: 40 }, (_, i) => 41 + i * 2),
  ];
  return prices.map((close, i) => ({ ts: startMs + i * DAY, close }));
}

/** 40 bars: flat at 100, then flat at 101 — a single +1% round trip. */
function tinyEdge(startMs: number): { ts: number; close: number }[] {
  return Array.from({ length: 40 }, (_, i) => ({ ts: startMs + i * DAY, close: i < 20 ? 100 : 101 }));
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

/** Buy the dip below 50, sell the rip above 90 → exactly one big winner. */
const buyLowSellHigh = {
  tsp: '0.1',
  id: 'bl',
  name: 'BL',
  definition: {
    kind: 'rules',
    rules: [
      { when: { lt: ['price', 50] }, signal: { side: 'buy' } },
      { when: { gt: ['price', 90] }, signal: { side: 'sell' } },
    ],
  },
};

/** Buy at 100, sell at 101 — a +1% gross edge that any real fee eats. */
const scalp = {
  tsp: '0.1',
  id: 'scalp',
  name: 'Scalp',
  definition: {
    kind: 'rules',
    rules: [
      { when: { lt: ['price', 100.5] }, signal: { side: 'buy' } },
      { when: { gt: ['price', 100.5] }, signal: { side: 'sell' } },
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
    const plugin = tsp.compile(buyLowSellHigh);
    const res = await runStrategyBacktest(plugin, { classes: ['crypto'], bankroll: 1000, timeframe: '1 year', fetchCloses });
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
      expect(c.totalCostUsd).toBe(0);
      // Assumptions are still reported so the UI can say what *would* have applied.
      expect(c.costs.roundTripBps).toBeGreaterThan(0);
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

describe('runStrategyBacktest cost accounting', () => {
  const fetchCloses: FetchCloses = async (_symbol, startMs) => dipAndRip(startMs);

  async function run(costs?: CostModel) {
    const res = await runStrategyBacktest(tsp.compile(buyLowSellHigh), {
      classes: ['crypto'],
      bankroll: 1000,
      timeframe: '1 year',
      fetchCloses,
      costs,
    });
    return res.classes[0]!;
  }

  it('nets returns below gross whenever costs are non-zero', async () => {
    const c = await run();
    expect(c.trades).toBeGreaterThan(0);
    expect(c.returnPct).toBeLessThan(c.grossReturnPct);
    expect(c.totalCostUsd).toBeGreaterThan(0);
    expect(c.costDragPct).toBeGreaterThan(0);
  });

  it('leaves no unattributed friction: gross − net is exactly the cost drag', async () => {
    const c = await run();
    expect(c.grossReturnPct - c.returnPct).toBeCloseTo(c.costDragPct, 10);
    expect(c.feesUsd + c.spreadSlippageUsd).toBeCloseTo(c.totalCostUsd, 8);
    expect(c.costDragPct).toBeCloseTo(c.totalCostUsd / 1000, 10);
  });

  it('charges nothing under ZERO_COST_MODEL, where net equals gross', async () => {
    const c = await run(ZERO_COST_MODEL);
    expect(c.totalCostUsd).toBe(0);
    expect(c.feesUsd).toBe(0);
    expect(c.spreadSlippageUsd).toBe(0);
    expect(c.costDragPct).toBe(0);
    expect(c.returnPct).toBeCloseTo(c.grossReturnPct, 12);
    expect(c.costs.roundTripBps).toBe(0);
  });

  it('actually deducts costs: a real model finishes below the frictionless run', async () => {
    const free = await run(ZERO_COST_MODEL);
    const paid = await run();
    expect(paid.finalEquity).toBeLessThan(free.finalEquity);
    // Same signals on the same bars, so the frictionless number matches.
    expect(paid.grossReturnPct).toBeCloseTo(free.returnPct, 10);
  });

  it('separates fee cost from spread cost', async () => {
    const fee = await run({ feeBps: 50, slippageBps: 0, assumedHalfSpreadBps: 0, perOrderUsd: 0 });
    expect(fee.feesUsd).toBeCloseTo(fee.totalCostUsd, 8);
    expect(fee.spreadSlippageUsd).toBeCloseTo(0, 8);

    const spread = await run({ feeBps: 0, slippageBps: 0, assumedHalfSpreadBps: 50, perOrderUsd: 0 });
    expect(spread.spreadSlippageUsd).toBeCloseTo(spread.totalCostUsd, 8);
    expect(spread.feesUsd).toBeCloseTo(0, 8);
  });

  it('compounds by netMultiple, not the price ratio, so fees cannot vanish', async () => {
    // Under a fee-only model the fills ARE the mid on both legs, so the price
    // ratio is identical to the frictionless run — anything compounding
    // exitPrice/entryPrice would report the gross number as net.
    const paid = await run({ feeBps: 100, slippageBps: 0, assumedHalfSpreadBps: 0, perOrderUsd: 0 });
    const free = await run(ZERO_COST_MODEL);

    expect(paid.grossReturnPct).toBeCloseTo(free.returnPct, 10);
    expect(paid.returnPct).toBeLessThan(paid.grossReturnPct);
    // One round trip at 100 bps/leg: 1 − (0.99/1.01) ≈ 1.98% of the slice.
    expect(1 - paid.finalEquity / free.finalEquity).toBeCloseTo(1 - 0.99 / 1.01, 6);
  });

  it('costs more the wider the model', async () => {
    const cheap = await run({ feeBps: 10, slippageBps: 1, assumedHalfSpreadBps: 1, perOrderUsd: 0 });
    const dear = await run({ feeBps: 60, slippageBps: 5, assumedHalfSpreadBps: 5, perOrderUsd: 0 });
    expect(dear.totalCostUsd).toBeGreaterThan(cheap.totalCostUsd);
    expect(dear.returnPct).toBeLessThan(cheap.returnPct);
    expect(dear.costs.roundTripBps).toBeGreaterThan(cheap.costs.roundTripBps);
  });

  it('defaults each class to its own model and reports the assumptions', async () => {
    const res = await runStrategyBacktest(tsp.compile(buyLowSellHigh), {
      classes: ['crypto', 'equity'],
      bankroll: 1200,
      timeframe: '1 year',
      fetchCloses,
    });
    const crypto = res.classes[0]!;
    const equity = res.classes[1]!;

    expect(DEFAULT_CLASS_COSTS.crypto).toBe(DEFAULT_COST_MODEL);
    expect(DEFAULT_CLASS_COSTS.equity).toBe(EQUITY_COST_MODEL);
    expect(crypto.costs.feeBps).toBe(DEFAULT_COST_MODEL.feeBps);
    expect(equity.costs.feeBps).toBe(EQUITY_COST_MODEL.feeBps);
    // Equities are commission-free here, so crypto must carry the bigger hurdle.
    expect(crypto.costs.roundTripBps).toBeGreaterThan(equity.costs.roundTripBps);
    expect(crypto.costDragPct).toBeGreaterThan(equity.costDragPct);
  });

  it('counts wins on net profit, so a cost-eaten winner is not a win', async () => {
    const thin: FetchCloses = async (_symbol, startMs) => tinyEdge(startMs);
    const opts = { classes: ['crypto'] as const, bankroll: 1000, timeframe: '1 year' as const, fetchCloses: thin };

    const free = await runStrategyBacktest(tsp.compile(scalp), { ...opts, classes: ['crypto'], costs: ZERO_COST_MODEL });
    const brutal = await runStrategyBacktest(tsp.compile(scalp), {
      ...opts,
      classes: ['crypto'],
      costs: { feeBps: 500, slippageBps: 0, assumedHalfSpreadBps: 0, perOrderUsd: 0 },
    });

    expect(free.classes[0]!.trades).toBeGreaterThan(0);
    expect(free.classes[0]!.winRate).toBe(1);
    expect(brutal.classes[0]!.trades).toBe(free.classes[0]!.trades);
    expect(brutal.classes[0]!.winRate).toBe(0);
    expect(brutal.classes[0]!.returnPct).toBeLessThan(0);
    expect(brutal.classes[0]!.grossReturnPct).toBeGreaterThan(0);
  });
});
