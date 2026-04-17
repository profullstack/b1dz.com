// @ts-nocheck
import { describe, it, expect } from 'vitest';
import { sma, ema, bollinger } from './indicators.js';

function mkBars(closes) {
  return closes.map((close, i) => ({ time: i, open: close, high: close, low: close, close, volume: 1 }));
}

describe('sma', () => {
  it('fills NaN for bars before the period completes', () => {
    const out = sma(mkBars([1, 2, 3, 4, 5]), 3);
    expect(out[0]).toBeNaN();
    expect(out[1]).toBeNaN();
    expect(out[2]).toBeCloseTo(2);
    expect(out[3]).toBeCloseTo(3);
    expect(out[4]).toBeCloseTo(4);
  });
});

describe('ema', () => {
  it('is seeded by the period SMA and smooths subsequent closes', () => {
    const out = ema(mkBars([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), 3);
    expect(out[0]).toBeNaN();
    expect(out[1]).toBeNaN();
    expect(out[2]).toBeCloseTo(2); // seed
    expect(out[3]).toBeCloseTo(2 + 0.5 * (4 - 2), 6); // k=0.5
    expect(out[9]).toBeGreaterThan(out[2]);
  });
});

describe('bollinger', () => {
  it('centers the middle band on the SMA', () => {
    const closes = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20];
    const { middle, upper, lower } = bollinger(mkBars(closes), 5, 2);
    expect(middle[4]).toBeCloseTo(12);
    expect(middle[9]).toBeCloseTo(17);
    for (let i = 4; i < closes.length; i += 1) {
      expect(upper[i]).toBeGreaterThan(middle[i]);
      expect(lower[i]).toBeLessThan(middle[i]);
    }
  });

  it('widens bands on higher volatility', () => {
    const calm = mkBars([100, 101, 100, 101, 100, 101, 100, 101, 100, 101]);
    const wild = mkBars([100, 120,  80, 130,  70, 140,  60, 150,  50, 160]);
    const calmB = bollinger(calm, 5, 2);
    const wildB = bollinger(wild, 5, 2);
    const i = 9;
    const calmSpread = calmB.upper[i] - calmB.lower[i];
    const wildSpread = wildB.upper[i] - wildB.lower[i];
    expect(wildSpread).toBeGreaterThan(calmSpread * 5);
  });
});
