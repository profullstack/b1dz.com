import { describe, it, expect } from 'vitest';
import type { MarketSnapshot } from '@b1dz/core';
import { validateDefinition, compile } from './index.js';
import { replayStrategy, summarizeTrades } from '../backtest.js';

function snap(price: number, ts: number): MarketSnapshot {
  return { exchange: 'test', pair: 'X-USD', bid: price, ask: price, bidSize: 1, askSize: 1, ts };
}
function stream(prices: number[]): { snap: MarketSnapshot; history: MarketSnapshot[] } {
  const s = prices.map((p, i) => snap(p, i));
  return { snap: s.at(-1)!, history: s.slice(0, -1) };
}

const rsiDip = {
  tsp: '0.1',
  id: 'rsi-dip',
  name: 'RSI Dip Buyer',
  author: 'tester',
  definition: {
    kind: 'rules',
    indicators: { rsi14: { fn: 'rsi', period: 14 } },
    rules: [
      { when: { lt: ['rsi14', 30] }, signal: { side: 'buy', strength: 0.8, reason: 'oversold' } },
      { when: { gt: ['rsi14', 70] }, signal: { side: 'sell', reason: 'overbought' } },
    ],
  },
};

describe('validateDefinition', () => {
  it('accepts a well-formed rules document', () => {
    expect(validateDefinition(rsiDip)).toEqual({ ok: true, errors: [] });
  });

  it('accepts a well-formed template document', () => {
    const doc = { tsp: '0.1', id: 't', name: 'T', definition: { kind: 'template', template: 'breakout', params: { lookback: 10 } } };
    expect(validateDefinition(doc).ok).toBe(true);
  });

  it('rejects an unsupported protocol version', () => {
    const r = validateDefinition({ ...rsiDip, tsp: '9.9' });
    expect(r.ok).toBe(false);
    expect(r.errors.join()).toMatch(/protocol version/);
  });

  it('rejects an operand referencing an undeclared indicator', () => {
    const r = validateDefinition({
      ...rsiDip,
      definition: { kind: 'rules', indicators: {}, rules: [{ when: { lt: ['ghost', 30] }, signal: { side: 'buy' } }] },
    });
    expect(r.ok).toBe(false);
    expect(r.errors.join()).toMatch(/unknown operand "ghost"/);
  });

  it('rejects a condition with more than one operator key', () => {
    const r = validateDefinition({
      ...rsiDip,
      definition: { kind: 'rules', rules: [{ when: { lt: ['price', 1], gt: ['price', 0] }, signal: { side: 'buy' } }] },
    });
    expect(r.ok).toBe(false);
    expect(r.errors.join()).toMatch(/exactly one operator/);
  });

  it('rejects an unknown definition kind', () => {
    const r = validateDefinition({ tsp: '0.1', id: 'x', name: 'X', definition: { kind: 'neural-net' } });
    expect(r.ok).toBe(false);
    expect(r.errors.join()).toMatch(/kind/);
  });
});

describe('compile (rules)', () => {
  it('throws on an invalid document', () => {
    expect(() => compile({ tsp: '0.1', id: 'x', name: 'X', definition: { kind: 'rules', rules: [] } })).toThrow(/Invalid TSP/);
  });

  it('buys an oversold series and sells an overbought one', () => {
    const plugin = compile(rsiDip);
    const down = stream(Array.from({ length: 20 }, (_, i) => 100 - i * 2)); // RSI → ~0
    expect(plugin.evaluate(down.snap, down.history)?.side).toBe('buy');
    const up = stream(Array.from({ length: 20 }, (_, i) => 100 + i * 2)); // RSI → ~100
    expect(plugin.evaluate(up.snap, up.history)?.side).toBe('sell');
  });

  it('clamps strength into [0,1] and applies the default reason', () => {
    const plugin = compile({
      tsp: '0.1', id: 'c', name: 'C',
      definition: { kind: 'rules', rules: [{ when: { gt: ['price', 0] }, signal: { side: 'buy', strength: 5 } }] },
    });
    const s = stream([1, 2, 3]);
    const sig = plugin.evaluate(s.snap, s.history);
    expect(sig?.strength).toBe(1);
    expect(sig?.reason).toMatch(/buy rule matched/);
  });

  it('first matching rule wins', () => {
    const plugin = compile({
      tsp: '0.1', id: 'fm', name: 'FM',
      definition: { kind: 'rules', rules: [
        { when: { gt: ['price', 0] }, signal: { side: 'buy', reason: 'first' } },
        { when: { gt: ['price', 0] }, signal: { side: 'sell', reason: 'second' } },
      ] },
    });
    const s = stream([10, 11]);
    expect(plugin.evaluate(s.snap, s.history)?.reason).toBe('first');
  });

  it('supports and/or/not boolean trees', () => {
    const plugin = compile({
      tsp: '0.1', id: 'bt', name: 'BT',
      definition: { kind: 'rules', indicators: { ema3: { fn: 'ema', period: 3 } }, rules: [
        { when: { and: [{ gt: ['price', 'ema3'] }, { not: { lt: ['price', 0] } }] }, signal: { side: 'buy' } },
      ] },
    });
    const up = stream([1, 2, 3, 4, 5, 6]); // price above short EMA
    expect(plugin.evaluate(up.snap, up.history)?.side).toBe('buy');
  });

  it('returns null until there is enough data for the indicators', () => {
    const plugin = compile(rsiDip); // rsi14 needs 15 points
    const s = stream([1, 2, 3]);
    expect(plugin.evaluate(s.snap, s.history)).toBeNull();
  });
});

describe('compile (template)', () => {
  it('honors numeric param overrides (breakout lookback)', () => {
    // 25 bars: an early high (120), a long descent to 86, then a small bump to 92.
    // 92 breaks the last 5-bar high (~90) but sits well inside the 20-bar range
    // (whose high is ~105), so lookback=5 buys while lookback=20 stays flat.
    const prices = [120, ...Array.from({ length: 23 }, (_, i) => 108 - i), 92];
    const s = stream(prices);

    const loose = compile({ tsp: '0.1', id: 'b5', name: 'B5', definition: { kind: 'template', template: 'breakout', params: { lookback: 5 } } });
    expect(loose.evaluate(s.snap, s.history)?.side).toBe('buy');

    const strict = compile({ tsp: '0.1', id: 'b20', name: 'B20', definition: { kind: 'template', template: 'breakout', params: { lookback: 20 } } });
    expect(strict.evaluate(s.snap, s.history)).toBeNull();
  });
});

describe('integration: a TSP strategy backtests through replayStrategy', () => {
  it('produces scorable round-trip trades', () => {
    const plugin = compile(rsiDip);
    // oversold dip (→buy) then a recovery to overbought (→sell)
    const prices = [
      ...Array.from({ length: 20 }, (_, i) => 100 - i * 2), // crash → oversold
      ...Array.from({ length: 20 }, (_, i) => 62 + i * 3), // rip → overbought
    ];
    const snaps = prices.map((p, i) => snap(p, i));
    const trades = replayStrategy(plugin, snaps, 100);
    expect(trades.length).toBeGreaterThanOrEqual(1);
    const summary = summarizeTrades(trades);
    expect(summary.trades).toBe(trades.length);
    expect(Number.isFinite(summary.returnPct)).toBe(true);
  });
});
