/**
 * Unit tests for the Gemini L2 → top-of-book reconstruction in
 * ws-price-cache.ts.
 *
 * The previous heuristic ("update bid only when price > current bid")
 * stuck on stale prices the moment the original top-of-book level
 * disappeared. These tests exercise the corrected behavior: a real
 * book that recomputes max(bid prices) and min(ask prices) on every
 * applied L2 frame.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  __injectGeminiFrameForTests,
  __resetWsCacheForTests,
} from './ws-price-cache.js';

describe('gemini ws book reconstruction', () => {
  afterEach(() => {
    __resetWsCacheForTests();
  });

  it('builds a top-of-book from a multi-level snapshot frame', () => {
    const snap = __injectGeminiFrameForTests('BTC-USD', [
      { type: 'change', side: 'bid', price: '62000.00', remaining: '0.5' },
      { type: 'change', side: 'bid', price: '61999.00', remaining: '1.0' },
      { type: 'change', side: 'ask', price: '62001.00', remaining: '0.3' },
      { type: 'change', side: 'ask', price: '62002.00', remaining: '2.0' },
    ]);
    expect(snap).not.toBeNull();
    expect(snap!.bid).toBe(62000);
    expect(snap!.ask).toBe(62001);
  });

  it('moves top bid DOWN when the original top level is removed', () => {
    // Build a 2-level book with 62000 at the top.
    __injectGeminiFrameForTests('BTC-USD', [
      { type: 'change', side: 'bid', price: '62000.00', remaining: '0.5' },
      { type: 'change', side: 'bid', price: '61500.00', remaining: '1.0' },
      { type: 'change', side: 'ask', price: '62100.00', remaining: '1.0' },
    ]);
    // Now remove the 62000 level.
    const snap = __injectGeminiFrameForTests('BTC-USD', [
      { type: 'change', side: 'bid', price: '62000.00', remaining: '0' },
    ]);
    expect(snap).not.toBeNull();
    expect(snap!.bid).toBe(61500); // dropped to next-best
  });

  it('moves top ask UP when the original top level is removed', () => {
    __injectGeminiFrameForTests('BTC-USD', [
      { type: 'change', side: 'bid', price: '62000.00', remaining: '0.5' },
      { type: 'change', side: 'ask', price: '62100.00', remaining: '0.3' },
      { type: 'change', side: 'ask', price: '62200.00', remaining: '2.0' },
    ]);
    const snap = __injectGeminiFrameForTests('BTC-USD', [
      { type: 'change', side: 'ask', price: '62100.00', remaining: '0' },
    ]);
    expect(snap).not.toBeNull();
    expect(snap!.ask).toBe(62200); // climbed to next-best
  });

  it('updates remaining without churning top when a non-top level resizes', () => {
    __injectGeminiFrameForTests('BTC-USD', [
      { type: 'change', side: 'bid', price: '62000.00', remaining: '0.5' },
      { type: 'change', side: 'bid', price: '61500.00', remaining: '1.0' },
      { type: 'change', side: 'ask', price: '62100.00', remaining: '1.0' },
    ]);
    const snap = __injectGeminiFrameForTests('BTC-USD', [
      { type: 'change', side: 'bid', price: '61500.00', remaining: '5.0' }, // resize lower level
    ]);
    expect(snap!.bid).toBe(62000); // top unchanged
    expect(snap!.ask).toBe(62100);
  });

  it('does not publish when one side of the book is empty', () => {
    const snap = __injectGeminiFrameForTests('BTC-USD', [
      { type: 'change', side: 'bid', price: '62000.00', remaining: '0.5' },
      // no asks at all
    ]);
    // The cache may have an old entry but no new publish should have
    // happened in this frame — verify the function reports null when
    // both sides aren't present.
    expect(snap).toBeNull();
  });

  it('applies a delete on a non-existent level without crashing', () => {
    const snap = __injectGeminiFrameForTests('BTC-USD', [
      { type: 'change', side: 'bid', price: '62000.00', remaining: '0.5' },
      { type: 'change', side: 'ask', price: '62100.00', remaining: '1.0' },
      { type: 'change', side: 'bid', price: '99999.00', remaining: '0' }, // never existed
    ]);
    expect(snap!.bid).toBe(62000);
    expect(snap!.ask).toBe(62100);
  });

  it('compares prices numerically, not lexically (string-length safety)', () => {
    // "9999.00" lex-orders before "62000.00" — but numerically 62000 > 9999.
    // The previous heuristic compared parseFloat-then-compare; the new
    // top-of-book scanner must do the same.
    const snap = __injectGeminiFrameForTests('BTC-USD', [
      { type: 'change', side: 'bid', price: '9999.00', remaining: '1.0' },
      { type: 'change', side: 'bid', price: '62000.00', remaining: '1.0' },
      { type: 'change', side: 'ask', price: '62100.00', remaining: '1.0' },
    ]);
    expect(snap!.bid).toBe(62000);
  });
});
