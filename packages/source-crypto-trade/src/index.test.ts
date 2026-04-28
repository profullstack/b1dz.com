import { describe, it, expect } from 'vitest';
import { __reconstructEntryFromFillsForTests, momentumStrategy } from './index.js';
import type { MarketSnapshot } from '@b1dz/core';

const snap = (bid: number, ts = 0): MarketSnapshot => ({
  exchange: 'gemini', pair: 'BTC-USD', bid, ask: bid + 0.5, bidSize: 1, askSize: 1, ts,
});

describe('momentumStrategy', () => {
  it('emits a buy signal on 3 rising ticks', () => {
    const sig = momentumStrategy.evaluate(snap(105), [snap(100), snap(102), snap(105)]);
    expect(sig).not.toBeNull();
    expect(sig?.side).toBe('buy');
  });

  it('returns null when not strictly rising', () => {
    expect(momentumStrategy.evaluate(snap(100), [snap(100), snap(102), snap(101)])).toBeNull();
  });

  it('returns null when history is too short', () => {
    expect(momentumStrategy.evaluate(snap(100), [snap(100)])).toBeNull();
  });
});

describe('reconstructEntryFromFills', () => {
  it('uses weighted cost of the currently held lots instead of only the latest buy', () => {
    const entry = __reconstructEntryFromFillsForTests(
      { amount: 3 },
      [
        { side: 'buy', pair: 'ETH-USD', price: 120, volume: 1, time: 3 },
        { side: 'buy', pair: 'ETH-USD', price: 100, volume: 2, time: 2 },
      ],
    );

    expect(entry?.matchedVolume).toBe(3);
    expect(entry?.entryPrice).toBeCloseTo((120 + 200) / 3);
    expect(entry?.entryTime).toBe(2);
  });

  it('returns null when no usable purchase price is available', () => {
    expect(__reconstructEntryFromFillsForTests(
      { amount: 1 },
      [{ side: 'sell', pair: 'ETH-USD', price: 100, volume: 1, time: 1 }],
    )).toBeNull();
  });
});
