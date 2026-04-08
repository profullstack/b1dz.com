import { describe, it, expect } from 'vitest';
import { momentumStrategy } from './index.js';
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
