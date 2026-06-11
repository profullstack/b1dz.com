import { describe, it, expect } from 'vitest';
import type { MarketSnapshot } from '@b1dz/core';
import { trendContinuation, meanReversion, breakout, STRATEGY_PLUGINS } from './index.js';

/** Build a snapshot at a given mid price (tight 2bps spread). */
function snap(price: number, ts = 0): MarketSnapshot {
  const half = price * 0.0001;
  return { exchange: 'test', pair: 'X-USD', bid: price - half, ask: price + half, bidSize: 1, askSize: 1, ts };
}

/** Turn a price array into (current, history) for evaluate(). */
function stream(prices: number[]): { snap: MarketSnapshot; history: MarketSnapshot[] } {
  const snaps = prices.map((p, i) => snap(p, i));
  return { snap: snaps.at(-1)!, history: snaps.slice(0, -1) };
}

describe('package shape', () => {
  it('ships three asset-agnostic strategy plugins', () => {
    expect(STRATEGY_PLUGINS).toHaveLength(3);
    for (const p of STRATEGY_PLUGINS) {
      expect(p.manifest.kind).toBe('strategy');
      expect(p.manifest.capabilities).toContain('asset:crypto');
      expect(p.manifest.capabilities).toContain('asset:equity');
      expect(typeof p.evaluate).toBe('function');
    }
  });
});

describe('trendContinuation', () => {
  it('returns null without enough history', () => {
    const { snap: s, history } = stream([100, 101, 102]);
    expect(trendContinuation.evaluate(s, history)).toBeNull();
  });

  it('buys a steady uptrend', () => {
    const prices = Array.from({ length: 60 }, (_, i) => 100 + i); // monotonic rise
    const { snap: s, history } = stream(prices);
    const sig = trendContinuation.evaluate(s, history);
    expect(sig?.side).toBe('buy');
    expect(sig!.strength).toBeGreaterThan(0);
  });

  it('sells a steady downtrend', () => {
    const prices = Array.from({ length: 60 }, (_, i) => 200 - i);
    const { snap: s, history } = stream(prices);
    expect(trendContinuation.evaluate(s, history)?.side).toBe('sell');
  });
});

describe('meanReversion', () => {
  it('buys an oversold series', () => {
    const prices = Array.from({ length: 20 }, (_, i) => 100 - i * 2); // straight down → RSI ~0
    const { snap: s, history } = stream(prices);
    const sig = meanReversion.evaluate(s, history);
    expect(sig?.side).toBe('buy');
    expect(sig!.reason).toMatch(/oversold/);
  });

  it('sells an overbought series', () => {
    const prices = Array.from({ length: 20 }, (_, i) => 100 + i * 2); // straight up → RSI ~100
    const { snap: s, history } = stream(prices);
    expect(meanReversion.evaluate(s, history)?.side).toBe('sell');
  });

  it('stays flat in the neutral band', () => {
    const prices = Array.from({ length: 30 }, (_, i) => 100 + (i % 2 === 0 ? 0.1 : -0.1));
    const { snap: s, history } = stream(prices);
    expect(meanReversion.evaluate(s, history)).toBeNull();
  });
});

describe('breakout', () => {
  it('buys a push above the prior range high', () => {
    const prices = [...Array.from({ length: 20 }, () => 100), 105]; // flat then break up
    const { snap: s, history } = stream(prices);
    const sig = breakout.evaluate(s, history);
    expect(sig?.side).toBe('buy');
    expect(sig!.reason).toMatch(/high/);
  });

  it('sells a break below the prior range low', () => {
    const prices = [...Array.from({ length: 20 }, () => 100), 95];
    const { snap: s, history } = stream(prices);
    expect(breakout.evaluate(s, history)?.side).toBe('sell');
  });

  it('stays flat inside the range', () => {
    const prices = [...Array.from({ length: 20 }, (_, i) => 100 + (i % 3)), 101];
    const { snap: s, history } = stream(prices);
    expect(breakout.evaluate(s, history)).toBeNull();
  });
});
