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
 */
export function trailingStopPriceFor(entryPrice: number, highWaterMark: number): number {
  const pnlPct = (highWaterMark - entryPrice) / entryPrice;
  if (pnlPct >= LOCK_TRIGGER_PCT) return entryPrice * (1 + LOCK_STOP_PCT);
  if (pnlPct >= BREAKEVEN_TRIGGER_PCT) return entryPrice;
  return entryPrice * (1 - INITIAL_STOP_PCT);
}
