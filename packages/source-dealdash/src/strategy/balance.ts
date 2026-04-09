/**
 * Bid balance state machine.
 *
 * Hysteresis: enter LOW mode at <= ENTER threshold, only EXIT at >= EXIT.
 * The gap prevents flapping when cancelling fights momentarily refills
 * our balance above the trip point.
 */

export interface BalanceMode {
  /** Currently in low-balance survival mode */
  inLow: boolean;
  /** Bid balance threshold to enter low mode */
  enterAt: number;
  /** Bid balance threshold to exit low mode */
  exitAt: number;
}

export interface BalanceTransition {
  next: BalanceMode;
  /** "entered" | "exited" | null */
  event: 'entered' | 'exited' | null;
}

export function makeBalanceMode(opts?: { enterAt?: number; exitAt?: number }): BalanceMode {
  return { inLow: false, enterAt: opts?.enterAt ?? 1000, exitAt: opts?.exitAt ?? 1500 };
}

export function applyBalance(state: BalanceMode, currentBalance: number): BalanceTransition {
  if (!state.inLow && currentBalance <= state.enterAt) {
    return { next: { ...state, inLow: true }, event: 'entered' };
  }
  if (state.inLow && currentBalance >= state.exitAt) {
    return { next: { ...state, inLow: false }, event: 'exited' };
  }
  return { next: state, event: null };
}
