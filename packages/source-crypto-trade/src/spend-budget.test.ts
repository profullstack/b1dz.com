import { describe, it, expect } from 'vitest';
import {
  windowStartFor,
  rolloverIfNeeded,
  checkSpendBudget,
  recordSpend,
  freshBudgetState,
  isBudgetWindow,
  type SpendBudgetState,
} from './spend-budget.js';

const MON = Date.UTC(2026, 5, 15, 12, 0, 0); // Mon 2026-06-15 12:00 UTC
const TUE = Date.UTC(2026, 5, 16, 9, 0, 0); // Tue 2026-06-16
const NEXT_MON = Date.UTC(2026, 5, 22, 1, 0, 0); // Mon 2026-06-22
const NEXT_MONTH = Date.UTC(2026, 6, 2, 1, 0, 0); // Thu 2026-07-02

describe('windowStartFor', () => {
  it('daily → midnight UTC', () => {
    expect(windowStartFor('daily', MON)).toBe(Date.UTC(2026, 5, 15));
  });
  it('weekly → most recent Monday', () => {
    expect(windowStartFor('weekly', TUE)).toBe(Date.UTC(2026, 5, 15));
    expect(windowStartFor('weekly', MON)).toBe(Date.UTC(2026, 5, 15));
  });
  it('monthly → 1st of month', () => {
    expect(windowStartFor('monthly', MON)).toBe(Date.UTC(2026, 5, 1));
  });
});

describe('isBudgetWindow', () => {
  it('validates', () => {
    expect(isBudgetWindow('daily')).toBe(true);
    expect(isBudgetWindow('weekly')).toBe(true);
    expect(isBudgetWindow('hourly')).toBe(false);
    expect(isBudgetWindow(5)).toBe(false);
  });
});

describe('checkSpendBudget', () => {
  const state = (over: Partial<SpendBudgetState> = {}): SpendBudgetState => ({
    spentUsd: 0,
    windowStart: windowStartFor('daily', MON),
    ...over,
  });

  it('allows when no budget is configured (unlimited)', () => {
    const d = checkSpendBudget({ budgetUsd: null, state: state(), orderUsd: 100, window: 'daily', now: MON });
    expect(d.allowed).toBe(true);
    expect(d.remainingUsd).toBe(Infinity);
    expect(d.allowedUsd).toBe(100);
  });

  it('allows a buy under the budget', () => {
    const d = checkSpendBudget({ budgetUsd: 500, state: state({ spentUsd: 100 }), orderUsd: 50, window: 'daily', now: MON });
    expect(d.allowed).toBe(true);
    expect(d.remainingUsd).toBe(400);
    expect(d.allowedUsd).toBe(50);
  });

  it('clamps a buy that partially exceeds the remaining budget', () => {
    const d = checkSpendBudget({ budgetUsd: 500, state: state({ spentUsd: 480 }), orderUsd: 50, window: 'daily', now: MON });
    expect(d.allowed).toBe(true);
    expect(d.allowedUsd).toBe(20);
    expect(d.reason).toContain('clamped');
  });

  it('rejects when the budget is exhausted', () => {
    const d = checkSpendBudget({ budgetUsd: 500, state: state({ spentUsd: 500 }), orderUsd: 50, window: 'daily', now: MON });
    expect(d.allowed).toBe(false);
    expect(d.allowedUsd).toBe(0);
    expect(d.remainingUsd).toBe(0);
  });

  it('rejects when remaining is below the exchange min-notional', () => {
    const d = checkSpendBudget({ budgetUsd: 500, state: state({ spentUsd: 499.5 }), orderUsd: 50, window: 'daily', now: MON, minOrderUsd: 1 });
    expect(d.allowed).toBe(false);
  });

  it('resets spend when the day rolls over', () => {
    const d = checkSpendBudget({ budgetUsd: 500, state: state({ spentUsd: 500 }), orderUsd: 50, window: 'daily', now: TUE });
    expect(d.allowed).toBe(true);
    expect(d.state.spentUsd).toBe(0);
    expect(d.allowedUsd).toBe(50);
  });

  it('keeps spend within the same week but resets on a new week', () => {
    const wk = freshBudgetState('weekly', MON);
    const same = checkSpendBudget({ budgetUsd: 500, state: { ...wk, spentUsd: 500 }, orderUsd: 50, window: 'weekly', now: TUE });
    expect(same.allowed).toBe(false); // still same week
    const next = checkSpendBudget({ budgetUsd: 500, state: { ...wk, spentUsd: 500 }, orderUsd: 50, window: 'weekly', now: NEXT_MON });
    expect(next.allowed).toBe(true);
    expect(next.state.spentUsd).toBe(0);
  });

  it('resets monthly budget across a month boundary', () => {
    const m = freshBudgetState('monthly', MON);
    const next = checkSpendBudget({ budgetUsd: 500, state: { ...m, spentUsd: 500 }, orderUsd: 50, window: 'monthly', now: NEXT_MONTH });
    expect(next.allowed).toBe(true);
  });
});

describe('recordSpend', () => {
  it('accumulates within a window', () => {
    let s = freshBudgetState('daily', MON);
    s = recordSpend(s, 100, 'daily', MON);
    s = recordSpend(s, 50, 'daily', MON);
    expect(s.spentUsd).toBe(150);
  });

  it('resets across a window rollover', () => {
    let s = freshBudgetState('daily', MON);
    s = recordSpend(s, 100, 'daily', MON);
    s = recordSpend(s, 50, 'daily', TUE);
    expect(s.spentUsd).toBe(50);
  });

  it('ignores non-positive amounts', () => {
    let s = freshBudgetState('daily', MON);
    s = recordSpend(s, -10, 'daily', MON);
    s = recordSpend(s, 0, 'daily', MON);
    expect(s.spentUsd).toBe(0);
  });
});

describe('rolloverIfNeeded', () => {
  it('is a no-op within the same window', () => {
    const s = freshBudgetState('daily', MON);
    expect(rolloverIfNeeded({ ...s, spentUsd: 99 }, 'daily', MON).spentUsd).toBe(99);
  });
});
