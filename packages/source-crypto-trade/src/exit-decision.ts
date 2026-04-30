/**
 * Pure exit-decision function. Extracted from index.ts so the guard matrix
 * (take-profit, trailing stop, min-hold, 15m-uptrend hold, hard-stop) is
 * unit-testable without a full daemon tick.
 */

import {
  TAKE_PROFIT_PCT,
  TIME_EXIT_MS,
  TIME_EXIT_FLAT_PCT,
  takeProfitPctFromEnv,
} from './trade-config.js';

export interface ExitDecisionInput {
  /** PnL as a fraction of entry (e.g. 0.008 = +0.8%). */
  pnlPct: number;
  /** Current best bid. */
  bid: number;
  /** Current trailing-stop price. */
  stopPrice: number;
  /** ms since position entry. */
  elapsed: number;
  /** MIN_HOLD_MS (post-entry shallow-exit suppression window). */
  minHoldMs: number;
  /** HARD_STOP_PCT — signed negative fraction (e.g. -0.02). */
  hardStopPct: number;
  /** 15m confirm-timeframe trend direction, or null if analysis unavailable. */
  confirmTrend: 'bull' | 'bear' | 'neutral' | null;
  /** Whether the tick also produced a qualifying strategy sell signal. */
  strategySell: { reason: string } | null;
}

export interface ExitDecision {
  /** Human-readable reason string if we should exit; null = hold. */
  exitReason: string | null;
  /** Why we suppressed an exit that would otherwise fire (for log visibility). */
  suppressReason: 'min-hold' | '15m-uptrend' | null;
}

export function decideExit(input: ExitDecisionInput): ExitDecision {
  const { pnlPct, bid, stopPrice, elapsed, minHoldMs, hardStopPct, confirmTrend, strategySell } = input;
  const inMinHold = elapsed < minHoldMs;
  const holdForUptrend = confirmTrend === 'bull' && pnlPct > hardStopPct;
  const takeProfitPct = takeProfitPctFromEnv();

  if (pnlPct >= takeProfitPct) {
    return { exitReason: `take-profit +${(pnlPct * 100).toFixed(2)}% (target ${(takeProfitPct * 100).toFixed(2)}%)`, suppressReason: null };
  }

  const stopHit = bid <= stopPrice;
  // Hard-stop check runs FIRST so the log tags it distinctly even when
  // the normal trailing-stop branch would also have fired.
  if (stopHit && pnlPct <= hardStopPct) {
    return { exitReason: `hard stop at $${stopPrice.toFixed(2)}`, suppressReason: null };
  }
  if (stopHit && !inMinHold && !holdForUptrend) {
    return { exitReason: `trailing stop at $${stopPrice.toFixed(2)}`, suppressReason: null };
  }
  if (elapsed >= TIME_EXIT_MS && Math.abs(pnlPct) < TIME_EXIT_FLAT_PCT) {
    return {
      exitReason: `time exit after ${(elapsed / 60000).toFixed(0)}min (flat ${(pnlPct * 100).toFixed(3)}%)`,
      suppressReason: null,
    };
  }

  const canUseStrategySell = (!inMinHold && !holdForUptrend) || pnlPct <= hardStopPct;
  if (canUseStrategySell && strategySell) {
    return { exitReason: `strategy sell: ${strategySell.reason}`, suppressReason: null };
  }

  // No exit. Report which guard held if the stop would otherwise have fired.
  if (stopHit && pnlPct > hardStopPct) {
    if (inMinHold) return { exitReason: null, suppressReason: 'min-hold' };
    if (holdForUptrend) return { exitReason: null, suppressReason: '15m-uptrend' };
  }
  return { exitReason: null, suppressReason: null };
}
