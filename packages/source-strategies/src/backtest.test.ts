import { describe, it, expect } from 'vitest';
import type { MarketSnapshot, StrategyPlugin, Signal } from '@b1dz/core';
import { replayStrategy, summarizeTrades, DEFAULT_AMOUNT_PER_ENTRY } from './backtest.js';
import { ZERO_COST_MODEL } from './costs.js';

/** Snapshot at a mid price (bid=ask, so mid === price). */
function snap(price: number, ts: number): MarketSnapshot {
  return { exchange: 'test', pair: 'X-USD', bid: price, ask: price, bidSize: 1, askSize: 1, ts };
}

function series(prices: number[]): MarketSnapshot[] {
  return prices.map((p, i) => snap(p, i));
}

/**
 * Scripted strategy: emits a preset side at given indices, null otherwise.
 * Lets us drive the replay state machine deterministically without leaning on
 * the real indicators.
 */
function scripted(plan: Record<number, Signal['side']>): StrategyPlugin {
  return {
    manifest: { id: 'scripted', kind: 'strategy', version: '0', name: 'Scripted', capabilities: [] },
    evaluate(snapshot, history) {
      const idx = history.length; // current bar's position in the stream
      const side = plan[idx];
      return side ? { side, strength: 1, reason: `${side}@${idx}` } : null;
    },
  };
}

describe('replayStrategy', () => {
  it('opens on buy and closes on sell, sizing each entry at amountPerEntry', () => {
    const snaps = series([100, 110, 120, 130]);
    // buy at bar 0 (price 100), sell at bar 2 (price 120)
    const trades = replayStrategy(scripted({ 0: 'buy', 2: 'sell' }), snaps, { amountPerEntry: 100, costs: ZERO_COST_MODEL });
    expect(trades).toHaveLength(1);
    const t = trades[0]!;
    expect(t.entryPrice).toBe(100);
    expect(t.exitPrice).toBe(120);
    expect(t.cost).toBe(100);
    expect(t.shares).toBeCloseTo(1);
    expect(t.proceeds).toBeCloseTo(120);
    expect(t.profit).toBeCloseTo(20);
    expect(t.tradeReturnPct).toBeCloseTo(0.2);
    expect(t.entryReason).toBe('buy@0');
    expect(t.exitReason).toBe('sell@2');
  });

  it('is long-only: ignores a sell while flat and a second buy while long', () => {
    const snaps = series([100, 105, 110, 115]);
    // sell@0 (flat → ignored), buy@1, buy@2 (already long → ignored), sell@3
    const trades = replayStrategy(scripted({ 0: 'sell', 1: 'buy', 2: 'buy', 3: 'sell' }), snaps, { amountPerEntry: 100, costs: ZERO_COST_MODEL });
    expect(trades).toHaveLength(1);
    expect(trades[0]!.entryPrice).toBe(105); // entered at bar 1, not re-entered at bar 2
    expect(trades[0]!.exitPrice).toBe(115);
  });

  it('marks an open position to the final bar', () => {
    const snaps = series([100, 90, 80]);
    const trades = replayStrategy(scripted({ 0: 'buy' }), snaps, { amountPerEntry: 100, costs: ZERO_COST_MODEL }); // never sells
    expect(trades).toHaveLength(1);
    expect(trades[0]!.exitPrice).toBe(80);
    expect(trades[0]!.exitReason).toBe('close at end');
    expect(trades[0]!.profit).toBeCloseTo(-20);
  });

  it('produces no trades when the strategy never signals', () => {
    expect(replayStrategy(scripted({}), series([100, 101, 102]), { amountPerEntry: 100, costs: ZERO_COST_MODEL })).toEqual([]);
  });

  it('treats a throwing evaluate() as no-signal instead of aborting', () => {
    const boom: StrategyPlugin = {
      manifest: { id: 'boom', kind: 'strategy', version: '0', name: 'Boom', capabilities: [] },
      evaluate() {
        throw new Error('strategy bug');
      },
    };
    expect(replayStrategy(boom, series([100, 101, 102]), { amountPerEntry: 100, costs: ZERO_COST_MODEL })).toEqual([]);
  });

  it('defaults amountPerEntry to DEFAULT_AMOUNT_PER_ENTRY', () => {
    const trades = replayStrategy(scripted({ 0: 'buy', 1: 'sell' }), series([100, 110]), { amountPerEntry: DEFAULT_AMOUNT_PER_ENTRY, costs: ZERO_COST_MODEL });
    expect(trades[0]!.cost).toBe(DEFAULT_AMOUNT_PER_ENTRY);
  });
});

describe('summarizeTrades', () => {
  it('returns a zeroed summary for no trades', () => {
    const s = summarizeTrades([]);
    expect(s).toMatchObject({ trades: 0, invested: 0, proceeds: 0, profit: 0, returnPct: 0, winRate: 0, maxDrawdown: 0 });
  });

  it('aggregates wins, losses, return, and win rate', () => {
    // one +$20 winner, one -$10 loser
    const snaps = series([100, 120]);
    const win = replayStrategy(scripted({ 0: 'buy', 1: 'sell' }), snaps, { amountPerEntry: 100, costs: ZERO_COST_MODEL });
    const loseSnaps = series([100, 90]);
    const lose = replayStrategy(scripted({ 0: 'buy', 1: 'sell' }), loseSnaps, { amountPerEntry: 100, costs: ZERO_COST_MODEL });
    const s = summarizeTrades([...win, ...lose]);
    expect(s.trades).toBe(2);
    expect(s.invested).toBe(200);
    expect(s.profit).toBeCloseTo(10);
    expect(s.returnPct).toBeCloseTo(0.05);
    expect(s.wins).toBe(1);
    expect(s.losses).toBe(1);
    expect(s.winRate).toBeCloseTo(0.5);
  });

  it('tracks peak-to-trough drawdown across the trade sequence', () => {
    // sequence of realized profits: +30, -50, +10 → equity 30, -20, -10
    // peak 30, trough -20 → max drawdown 50
    const t = (entry: number, exit: number) =>
      replayStrategy(scripted({ 0: 'buy', 1: 'sell' }), series([entry, exit]), { amountPerEntry: 100, costs: ZERO_COST_MODEL });
    const trades = [
      ...t(100, 130), // +30
      ...t(100, 50), // -50
      ...t(100, 110), // +10
    ];
    const s = summarizeTrades(trades);
    expect(s.maxDrawdown).toBeCloseTo(50);
  });
});
