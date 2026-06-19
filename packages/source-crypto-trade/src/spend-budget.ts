/**
 * Crypto spend budget — pure, deterministic budget logic.
 *
 * This is the single safety primitive that every BUY (engine, AI-analyzer, or
 * external agent) is hard-capped against. It is intentionally dependency-free
 * and side-effect-free so it can be unit tested in isolation (mirrors the
 * `@b1dz/equity-engine` decision-function style) and re-used server-side by the
 * agent API.
 *
 * The engine holds the live mutable state and a daily/weekly/monthly window;
 * this module only answers "given this state + budget, may I spend `orderUsd`,
 * and what's left?" plus the window-rollover arithmetic.
 */

export type BudgetWindow = 'daily' | 'weekly' | 'monthly';

export const BUDGET_WINDOWS: readonly BudgetWindow[] = ['daily', 'weekly', 'monthly'];

export function isBudgetWindow(v: unknown): v is BudgetWindow {
  return typeof v === 'string' && (BUDGET_WINDOWS as readonly string[]).includes(v);
}

/** Mutable spend state for a single budget window. */
export interface SpendBudgetState {
  /** USD spent on buys within the current window. */
  spentUsd: number;
  /** Epoch ms of the start of the current window. */
  windowStart: number;
}

/**
 * Start-of-window epoch ms for `now`, in UTC.
 *  - daily   → 00:00:00 UTC today
 *  - weekly  → 00:00:00 UTC of the most recent Monday
 *  - monthly → 00:00:00 UTC on the 1st of this month
 */
export function windowStartFor(window: BudgetWindow, now: number): number {
  const d = new Date(now);
  if (window === 'monthly') {
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  }
  const dayStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  if (window === 'daily') return dayStart;
  // weekly: back up to Monday (getUTCDay: 0=Sun..6=Sat → Monday=1)
  const dow = new Date(dayStart).getUTCDay();
  const daysSinceMonday = (dow + 6) % 7;
  return dayStart - daysSinceMonday * 86_400_000;
}

export function freshBudgetState(window: BudgetWindow, now: number): SpendBudgetState {
  return { spentUsd: 0, windowStart: windowStartFor(window, now) };
}

/**
 * Returns the state rolled forward to the current window. If `now` has crossed
 * into a new window the spend counter resets to 0; otherwise the state is
 * returned unchanged.
 */
export function rolloverIfNeeded(
  state: SpendBudgetState,
  window: BudgetWindow,
  now: number,
): SpendBudgetState {
  const start = windowStartFor(window, now);
  if (start !== state.windowStart) return { spentUsd: 0, windowStart: start };
  return state;
}

export interface BudgetDecision {
  /** True when `orderUsd` (or a clamped portion) is allowed. */
  allowed: boolean;
  /** USD still available this window AFTER rollover (Infinity when no budget). */
  remainingUsd: number;
  /** The largest amount that may actually be spent now (min of order and remaining). */
  allowedUsd: number;
  /** State rolled forward to `now` (caller should persist this). */
  state: SpendBudgetState;
  /** Human-readable reason for logs/UI. */
  reason: string;
}

/**
 * Core check. `budgetUsd == null` (or <= 0) means "no spend budget configured"
 * → unlimited (the engine's own per-position cap still applies upstream).
 *
 * `minOrderUsd` is the smallest order worth placing (exchange min-notional);
 * if the remaining budget is below it, the buy is rejected rather than clamped
 * to dust.
 */
export function checkSpendBudget(args: {
  budgetUsd: number | null | undefined;
  state: SpendBudgetState;
  orderUsd: number;
  window: BudgetWindow;
  now: number;
  minOrderUsd?: number;
}): BudgetDecision {
  const { budgetUsd, orderUsd, window, now } = args;
  const minOrderUsd = args.minOrderUsd ?? 0;
  const state = rolloverIfNeeded(args.state, window, now);

  if (budgetUsd == null || !Number.isFinite(budgetUsd) || budgetUsd <= 0) {
    return {
      allowed: true,
      remainingUsd: Infinity,
      allowedUsd: orderUsd,
      state,
      reason: 'no spend budget configured',
    };
  }

  const remaining = Math.max(0, budgetUsd - state.spentUsd);
  if (remaining < Math.max(minOrderUsd, 0.000001)) {
    return {
      allowed: false,
      remainingUsd: remaining,
      allowedUsd: 0,
      state,
      reason: `budget: $${state.spentUsd.toFixed(2)} of $${budgetUsd.toFixed(2)} spent this ${window} — none remaining`,
    };
  }

  const allowedUsd = Math.min(orderUsd, remaining);
  return {
    allowed: true,
    remainingUsd: remaining,
    allowedUsd,
    state,
    reason: allowedUsd < orderUsd
      ? `budget: clamped $${orderUsd.toFixed(2)} → $${allowedUsd.toFixed(2)} ($${remaining.toFixed(2)} left this ${window})`
      : `budget: $${remaining.toFixed(2)} of $${budgetUsd.toFixed(2)} left this ${window}`,
  };
}

/** Record a confirmed spend, returning the new (rolled-forward) state. */
export function recordSpend(
  state: SpendBudgetState,
  usd: number,
  window: BudgetWindow,
  now: number,
): SpendBudgetState {
  const next = rolloverIfNeeded(state, window, now);
  if (!Number.isFinite(usd) || usd <= 0) return next;
  return { spentUsd: next.spentUsd + usd, windowStart: next.windowStart };
}
