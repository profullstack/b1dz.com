/**
 * Shared trade-management parameters used by both the live daemon and the
 * backtest simulator. The point of moving these here is that backtest
 * results must reflect actual live behavior — same stops, same targets,
 * same cooldowns, same halt thresholds.
 *
 * If you tune any of these, the next backtest run will immediately show
 * you the effect of the change on historical candles.
 */

/** Fixed take-profit target as a fraction of entry price. */
export const TAKE_PROFIT_PCT = 0.008; // +0.8%

/** Fixed initial stop-loss as a fraction of entry price. */
export const INITIAL_STOP_PCT = 0.004; // -0.4%

/** Move stop to breakeven once price has advanced this far. */
export const BREAKEVEN_TRIGGER_PCT = 0.003; // +0.3%

/** When price advances past LOCK_TRIGGER, move stop to LOCK_STOP. */
export const LOCK_TRIGGER_PCT = 0.005; // +0.5%
export const LOCK_STOP_PCT = 0.002; // +0.2%

/** Continuous trailing distance below the high-water mark, active once
 *  pnl is past LOCK_TRIGGER_PCT. The stop never moves down — we take
 *  the max of the legacy floor (entry × (1 + LOCK_STOP_PCT)) and
 *  HWM × (1 - TRAIL_PCT).
 *
 *  With the default 1% trail and LOCK_STOP=+0.2%, the trail starts
 *  actually "ratcheting up" once HWM ≈ entry × 1.0121 (≈ +1.21%). Below
 *  that, the +0.2% floor wins and behavior matches the old step-lock. */
export const TRAIL_PCT = 0.01; // 1.0%

export function trailPctFromEnv(): number {
  const v = Number.parseFloat(process.env.TRAIL_PCT ?? String(TRAIL_PCT));
  return Number.isFinite(v) && v > 0 ? v : TRAIL_PCT;
}

/** Aggressive buy slippage buffer — submit limit BUY orders at
 *  `ask × (1 + BUY_SLIPPAGE_BPS/10000)` with IOC (immediate or cancel).
 *
 *  Fixes the partial-fill trap: a GTC limit at the exact ask only sweeps
 *  the top book layer on thin markets (e.g. RAVE-USD on Coinbase) and
 *  leaves the remainder as an open order that locks USD. With IOC +
 *  slippage ceiling, the order walks up to N bps of depth, fills what's
 *  available, and cancels the rest — no orphan open orders. */
export const BUY_SLIPPAGE_BPS = 50; // 0.5%

export function buySlippageBpsFromEnv(): number {
  const v = Number.parseFloat(process.env.BUY_SLIPPAGE_BPS ?? String(BUY_SLIPPAGE_BPS));
  return Number.isFinite(v) && v >= 0 ? v : BUY_SLIPPAGE_BPS;
}

/** Minimum signal strength (0-100) to accept a buy entry. Matches the
 *  analysis engine's `minScore`. Lower = more aggressive (more entries,
 *  more whipsaws); higher = pickier (fewer entries, fewer drawdowns).
 *  Tune via ENTRY_MIN_SCORE env. Default 75. */
export const ENTRY_MIN_SCORE_DEFAULT = 75;

export function entryMinScoreFromEnv(): number {
  const v = Number.parseFloat(process.env.ENTRY_MIN_SCORE ?? String(ENTRY_MIN_SCORE_DEFAULT));
  if (!Number.isFinite(v)) return ENTRY_MIN_SCORE_DEFAULT;
  return Math.max(0, Math.min(100, v));
}

/** Close at market if position is flat within ±TIME_EXIT_FLAT_PCT after TIME_EXIT_MS. */
export const TIME_EXIT_MS = 15 * 60 * 1000; // 15 min
export const TIME_EXIT_FLAT_PCT = 0.001; // ±0.1%

/** Don't re-enter the same pair for this long after closing a position. */
export const COOLDOWN_MS = 3 * 60 * 1000; // 3 min

/** Halt new entries when cumulative daily net loss exceeds this fraction of starting equity. */
export const DAILY_LOSS_LIMIT_PCT_DEFAULT = 5; // 5%

export function dailyLossLimitPctFromEnv(): number {
  const value = Number.parseFloat(process.env.DAILY_LOSS_LIMIT_PCT ?? String(DAILY_LOSS_LIMIT_PCT_DEFAULT));
  return Number.isFinite(value) && value > 0 ? value : DAILY_LOSS_LIMIT_PCT_DEFAULT;
}

/**
 * Compute the trailing-stop price for an open long position given the
 * highest price seen since entry. Mirrors trailingStopPrice in index.ts.
 *
 * Stages:
 *   - pnl < BREAKEVEN_TRIGGER_PCT → fixed stop at entry × (1 - INITIAL_STOP_PCT)
 *   - BREAKEVEN_TRIGGER_PCT ≤ pnl < LOCK_TRIGGER_PCT → stop at breakeven (entry)
 *   - pnl ≥ LOCK_TRIGGER_PCT → max(entry × (1 + LOCK_STOP_PCT), HWM × (1 - TRAIL_PCT))
 *
 * The final `max(...)` is what makes this a real trailing stop: once
 * HWM gets far enough above entry, the stop ratchets up to follow it,
 * locking in more of the run. It never moves down because HWM is
 * monotonic and TRAIL_PCT is fixed.
 */
export function trailingStopPriceFor(
  entryPrice: number,
  highWaterMark: number,
  trailPct: number = TRAIL_PCT,
): number {
  const pnlPct = (highWaterMark - entryPrice) / entryPrice;
  if (pnlPct >= LOCK_TRIGGER_PCT) {
    const floor = entryPrice * (1 + LOCK_STOP_PCT);
    const trail = highWaterMark * (1 - trailPct);
    return Math.max(floor, trail);
  }
  if (pnlPct >= BREAKEVEN_TRIGGER_PCT) return entryPrice;
  return entryPrice * (1 - INITIAL_STOP_PCT);
}
