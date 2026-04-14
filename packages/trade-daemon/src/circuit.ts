/**
 * Circuit breaker / kill switch (PRD §25.3).
 *
 * Tracks signals the daemon must react to by halting execution:
 *   - N consecutive executor failures (tx revert, stuck, aborted)
 *   - realized daily loss beyond a USD threshold
 *   - gas spike (surfaced by the caller observing the gas oracle)
 *   - chain / RPC degradation (caller signals)
 *   - wallet balance too low (caller signals)
 *
 * State machine:
 *
 *   closed ──(trip)──▶ open ──(reset)──▶ closed
 *
 * Once tripped, the daemon refuses to execute until an operator
 * calls `reset()`. This is intentional — automatic re-closing invites
 * the same failure mode. Humans in the loop for kill-switch recovery.
 */

export type CircuitState = 'closed' | 'open';

export interface CircuitTrip {
  at: number;
  reason: string;
}

export interface CircuitConfig {
  /** Consecutive executor failures before tripping. Default 3. */
  maxConsecutiveFailures: number;
  /** Realized daily loss cap in USD (positive number). Default 100. */
  maxDailyLossUsd: number;
  /** Hour-of-day when the daily counter resets (UTC). Default 0. */
  dailyResetHourUtc: number;
}

export const DEFAULT_CIRCUIT_CONFIG: CircuitConfig = {
  maxConsecutiveFailures: 3,
  maxDailyLossUsd: 100,
  dailyResetHourUtc: 0,
};

export class CircuitBreaker {
  private state: CircuitState = 'closed';
  private tripRecord: CircuitTrip | null = null;
  private consecutiveFailures = 0;
  private dailyLossUsd = 0;
  /** Last time we reset the daily counter. */
  private dayAnchor: number;
  private readonly config: CircuitConfig;
  private readonly now: () => number;

  constructor(opts: {
    config?: Partial<CircuitConfig>;
    now?: () => number;
  } = {}) {
    this.config = { ...DEFAULT_CIRCUIT_CONFIG, ...(opts.config ?? {}) };
    this.now = opts.now ?? (() => Date.now());
    this.dayAnchor = this.now();
  }

  /** Returns null when execution may proceed, or a trip reason when
   *  the breaker is open. */
  canExecute(): string | null {
    if (this.state === 'open') {
      return `circuit open: ${this.tripRecord?.reason ?? 'unknown'}`;
    }
    return null;
  }

  /** Signal that an execution attempt just completed. Positive
   *  `realizedPnlUsd` means we made money on that trade; negative
   *  means we lost. */
  recordExecution(result: {
    filled: boolean;
    realizedPnlUsd?: number;
  }): void {
    this.maybeRollDay();
    if (result.filled) {
      this.consecutiveFailures = 0;
    } else {
      this.consecutiveFailures += 1;
      if (this.consecutiveFailures >= this.config.maxConsecutiveFailures) {
        this.tripBreaker(`${this.consecutiveFailures} consecutive execution failures`);
      }
    }
    if (typeof result.realizedPnlUsd === 'number') {
      if (result.realizedPnlUsd < 0) {
        this.dailyLossUsd += -result.realizedPnlUsd;
        if (this.dailyLossUsd >= this.config.maxDailyLossUsd) {
          this.tripBreaker(`daily loss $${this.dailyLossUsd.toFixed(2)} >= max $${this.config.maxDailyLossUsd}`);
        }
      }
    }
  }

  /** External signal: gas/RPC degradation, wallet too low, etc. */
  trip(reason: string): void {
    this.tripBreaker(reason);
  }

  /** Manually clear the breaker. Resets all counters. */
  reset(): void {
    this.state = 'closed';
    this.tripRecord = null;
    this.consecutiveFailures = 0;
    this.dailyLossUsd = 0;
    this.dayAnchor = this.now();
  }

  status(): { state: CircuitState; trip: CircuitTrip | null; consecutiveFailures: number; dailyLossUsd: number } {
    return {
      state: this.state,
      trip: this.tripRecord,
      consecutiveFailures: this.consecutiveFailures,
      dailyLossUsd: this.dailyLossUsd,
    };
  }

  private tripBreaker(reason: string): void {
    if (this.state === 'open') return;
    this.state = 'open';
    this.tripRecord = { at: this.now(), reason };
  }

  private maybeRollDay(): void {
    const now = this.now();
    const anchorDay = dayBucket(this.dayAnchor, this.config.dailyResetHourUtc);
    const nowDay = dayBucket(now, this.config.dailyResetHourUtc);
    if (nowDay !== anchorDay) {
      this.dailyLossUsd = 0;
      this.dayAnchor = now;
    }
  }
}

function dayBucket(ms: number, resetHourUtc: number): number {
  const d = new Date(ms);
  d.setUTCHours(d.getUTCHours() - resetHourUtc);
  return Math.floor(d.getTime() / 86_400_000);
}
