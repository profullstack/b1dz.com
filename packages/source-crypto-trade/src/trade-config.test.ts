import { describe, it, expect } from 'vitest';
import {
  trailingStopPriceFor,
  INITIAL_STOP_PCT,
  LOCK_STOP_PCT,
  LOCK_TRIGGER_PCT,
  TRAIL_PCT,
} from './trade-config.js';

describe('trailingStopPriceFor', () => {
  const ENTRY = 100;

  it('uses the fixed initial stop when pnl is below the breakeven trigger', () => {
    const hwm = ENTRY * 1.001; // +0.1% — below BREAKEVEN_TRIGGER (0.3%)
    expect(trailingStopPriceFor(ENTRY, hwm)).toBeCloseTo(ENTRY * (1 - INITIAL_STOP_PCT), 6);
  });

  it('moves to breakeven once pnl crosses the breakeven trigger', () => {
    const hwm = ENTRY * 1.004; // +0.4% — between BREAKEVEN (0.3%) and LOCK (0.5%)
    expect(trailingStopPriceFor(ENTRY, hwm)).toBe(ENTRY);
  });

  it('locks at LOCK_STOP floor when HWM is just past LOCK_TRIGGER (trail still below floor)', () => {
    // HWM at +0.6%: trail = 100.6 × 0.99 = 99.594 < floor = 100.2 → floor wins.
    const hwm = ENTRY * 1.006;
    expect(trailingStopPriceFor(ENTRY, hwm)).toBeCloseTo(ENTRY * (1 + LOCK_STOP_PCT), 6);
  });

  it('ratchets up continuously once trail exceeds the lock floor', () => {
    // With TRAIL_PCT=1% and LOCK_STOP=+0.2%, the trail overtakes the
    // floor when HWM × 0.99 > entry × 1.002 → HWM > entry × 1.0121.
    const hwm = ENTRY * 1.02; // +2% — well above crossover
    const expected = hwm * (1 - TRAIL_PCT);
    expect(trailingStopPriceFor(ENTRY, hwm)).toBeCloseTo(expected, 6);
    expect(trailingStopPriceFor(ENTRY, hwm)).toBeGreaterThan(ENTRY * (1 + LOCK_STOP_PCT));
  });

  it('regression: real RAVE-USD scenario — entry $17, HWM $18.68', () => {
    // Under the old logic this was stuck at $17.034 (entry + 0.2%).
    // Under continuous trail with default 1%: max($17.034, $18.68 × 0.99)
    //   = max($17.034, $18.4932) = $18.4932.
    const entry = 17;
    const hwm = 18.68;
    const stop = trailingStopPriceFor(entry, hwm);
    expect(stop).toBeCloseTo(18.4932, 3);
    // Should lock in about +8.8% profit instead of the old +0.2%.
    expect((stop - entry) / entry).toBeGreaterThan(0.08);
  });

  it('never moves the stop down as HWM advances', () => {
    let prev = trailingStopPriceFor(ENTRY, ENTRY * 1.006);
    for (const pct of [1.01, 1.02, 1.05, 1.1, 1.2]) {
      const curr = trailingStopPriceFor(ENTRY, ENTRY * pct);
      expect(curr).toBeGreaterThanOrEqual(prev);
      prev = curr;
    }
  });

  it('respects a custom trailPct argument', () => {
    const hwm = ENTRY * 1.05;
    // With 0.5% trail the stop sits tighter.
    const tightStop = trailingStopPriceFor(ENTRY, hwm, 0.005);
    const wideStop = trailingStopPriceFor(ENTRY, hwm, 0.02);
    expect(tightStop).toBeCloseTo(hwm * 0.995, 6);
    expect(wideStop).toBeCloseTo(hwm * 0.98, 6);
    expect(tightStop).toBeGreaterThan(wideStop);
  });

  it('crossover HWM where trail starts to win against the lock floor', () => {
    // Below crossover: floor wins.
    const below = trailingStopPriceFor(ENTRY, ENTRY * 1.012);
    expect(below).toBeCloseTo(ENTRY * (1 + LOCK_STOP_PCT), 6);
    // At crossover (+1.21%): roughly equal.
    const at = trailingStopPriceFor(ENTRY, ENTRY * 1.0121);
    expect(Math.abs(at - ENTRY * (1 + LOCK_STOP_PCT))).toBeLessThan(0.001);
    // Above crossover: trail wins.
    const above = trailingStopPriceFor(ENTRY, ENTRY * 1.015);
    expect(above).toBeGreaterThan(ENTRY * (1 + LOCK_STOP_PCT));
    expect(above).toBeCloseTo(ENTRY * 1.015 * (1 - TRAIL_PCT), 6);
  });
});
