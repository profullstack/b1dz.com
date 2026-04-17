import { describe, it, expect } from 'vitest';
import { decideExit, type ExitDecisionInput } from './exit-decision.js';
import { TAKE_PROFIT_PCT, TIME_EXIT_MS } from './trade-config.js';

// Defaults chosen so tests only need to override the field they care about.
const base: ExitDecisionInput = {
  pnlPct: 0,
  bid: 100,
  stopPrice: 99,
  elapsed: 10 * 60_000, // 10 min — past MIN_HOLD
  minHoldMs: 2 * 60_000,
  hardStopPct: -0.02,
  confirmTrend: 'neutral',
  strategySell: null,
};

describe('decideExit', () => {
  it('exits on take-profit regardless of guards', () => {
    const d = decideExit({ ...base, pnlPct: TAKE_PROFIT_PCT + 0.001, elapsed: 1000, confirmTrend: 'bull' });
    expect(d.exitReason).toMatch(/take-profit/);
  });

  it('exits on trailing stop when past min-hold and trend is not bullish', () => {
    const d = decideExit({ ...base, bid: 98, stopPrice: 99 });
    expect(d.exitReason).toMatch(/trailing stop/);
  });

  it('SUPPRESSES trailing stop inside min-hold window', () => {
    const d = decideExit({ ...base, bid: 98, stopPrice: 99, elapsed: 30_000 });
    expect(d.exitReason).toBeNull();
    expect(d.suppressReason).toBe('min-hold');
  });

  it('SUPPRESSES trailing stop while 15m confirms bullish', () => {
    const d = decideExit({ ...base, bid: 98, stopPrice: 99, confirmTrend: 'bull', pnlPct: -0.005 });
    expect(d.exitReason).toBeNull();
    expect(d.suppressReason).toBe('15m-uptrend');
  });

  it('hard-stop OVERRIDES 15m-uptrend guard (catastrophic loss still exits)', () => {
    const d = decideExit({ ...base, bid: 95, stopPrice: 99, confirmTrend: 'bull', pnlPct: -0.03 });
    expect(d.exitReason).toMatch(/hard stop/);
  });

  it('hard-stop OVERRIDES min-hold guard', () => {
    const d = decideExit({ ...base, bid: 95, stopPrice: 99, elapsed: 30_000, pnlPct: -0.03 });
    expect(d.exitReason).toMatch(/hard stop/);
  });

  it('allows strategy sell once out of min-hold and not in uptrend', () => {
    const d = decideExit({ ...base, strategySell: { reason: 'rsi divergence' } });
    expect(d.exitReason).toMatch(/strategy sell: rsi divergence/);
  });

  it('SUPPRESSES strategy sell in min-hold', () => {
    const d = decideExit({ ...base, elapsed: 30_000, strategySell: { reason: 'rsi divergence' } });
    expect(d.exitReason).toBeNull();
  });

  it('SUPPRESSES strategy sell while 15m confirms bullish', () => {
    const d = decideExit({ ...base, confirmTrend: 'bull', strategySell: { reason: 'rsi divergence' } });
    expect(d.exitReason).toBeNull();
  });

  it('allows strategy sell while bullish if pnl is beneath hard-stop', () => {
    const d = decideExit({ ...base, pnlPct: -0.03, confirmTrend: 'bull', strategySell: { reason: 'rsi divergence' } });
    expect(d.exitReason).toMatch(/strategy sell/);
  });

  it('time-based flat exit after TIME_EXIT_MS when pnl near zero', () => {
    const d = decideExit({ ...base, elapsed: TIME_EXIT_MS + 1000, pnlPct: 0.0005 });
    expect(d.exitReason).toMatch(/time exit/);
  });

  it('does NOT time-exit if pnl has a real direction', () => {
    const d = decideExit({ ...base, elapsed: TIME_EXIT_MS + 1000, pnlPct: 0.004 });
    expect(d.exitReason).toBeNull();
  });

  it('holds when nothing triggers and no guard is suppressing', () => {
    const d = decideExit({ ...base, pnlPct: 0.003 });
    expect(d.exitReason).toBeNull();
    expect(d.suppressReason).toBeNull();
  });

  it('15m trend "bear" does NOT hold — allows normal exit path', () => {
    const d = decideExit({ ...base, bid: 98, stopPrice: 99, confirmTrend: 'bear' });
    expect(d.exitReason).toMatch(/trailing stop/);
  });

  it('confirmTrend null treats as non-bullish — does not hold', () => {
    const d = decideExit({ ...base, bid: 98, stopPrice: 99, confirmTrend: null });
    expect(d.exitReason).toMatch(/trailing stop/);
  });
});
