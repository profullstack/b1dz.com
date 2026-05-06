/**
 * Unit tests for the Gemini bookTicker → price-cache projection in
 * ws-price-cache.ts.
 *
 * The previous implementation reconstructed top-of-book from L2 deltas
 * on the legacy v1 marketdata socket. We now subscribe to the v2
 * trading-streams `bookTicker` channel which delivers top-of-book
 * directly (b/B/a/A), so the unit-of-test is much smaller: a frame
 * goes in, a snapshot comes out.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  __injectGeminiBookTickerForTests,
  __resetWsCacheForTests,
} from './ws-price-cache.js';

describe('gemini ws bookTicker projection', () => {
  afterEach(() => {
    __resetWsCacheForTests();
  });

  it('publishes a snapshot with bid + ask from a frame', () => {
    const snap = __injectGeminiBookTickerForTests('BTC-USD', {
      b: '62000.00',
      a: '62001.00',
      B: '0.5',
      A: '0.3',
    });
    expect(snap).not.toBeNull();
    expect(snap!.bid).toBe(62000);
    expect(snap!.ask).toBe(62001);
    expect(snap!.bidSize).toBe(0.5);
    expect(snap!.askSize).toBe(0.3);
  });

  it('overwrites the snapshot when a newer frame arrives', () => {
    __injectGeminiBookTickerForTests('BTC-USD', { b: '62000', a: '62001' });
    const snap = __injectGeminiBookTickerForTests('BTC-USD', { b: '62050', a: '62051' });
    expect(snap!.bid).toBe(62050);
    expect(snap!.ask).toBe(62051);
  });

  it('drops frames where bid or ask is non-numeric', () => {
    const snap = __injectGeminiBookTickerForTests('BTC-USD', { b: 'oops', a: '62001' });
    expect(snap).toBeNull();
  });

  it('drops frames with zero / negative prices', () => {
    expect(__injectGeminiBookTickerForTests('BTC-USD', { b: '0', a: '62001' })).toBeNull();
    expect(__injectGeminiBookTickerForTests('BTC-USD', { b: '62000', a: '-1' })).toBeNull();
  });

  it('treats missing size fields as zero', () => {
    const snap = __injectGeminiBookTickerForTests('BTC-USD', { b: '62000', a: '62001' });
    expect(snap!.bidSize).toBe(0);
    expect(snap!.askSize).toBe(0);
  });
});
