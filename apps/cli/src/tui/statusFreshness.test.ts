import { describe, it, expect } from 'vitest';
import {
  computeStatusFreshness,
  TRADE_STALE_AFTER_MS,
} from './statusFreshness.js';

const BASE = {
  realizedPnl: 0,
  realizedPnlPct: 0,
  totalFees: 0,
};

describe('computeStatusFreshness — loading state', () => {
  it('shows a "loading…" badge when tradeState has not landed yet', () => {
    const out = computeStatusFreshness({
      ...BASE,
      dataLoading: true,
      lastTickMs: null,
      nowMs: 1_700_000_000_000,
    });
    expect(out.freshnessStr).toContain('loading…');
    // When loading, we MUST NOT imply zeros are authoritative.
    expect(out.pnlStr).not.toMatch(/\$0\.00/);
    expect(out.feesStr).toBe('—');
    expect(out.pnlPctStr).toBe('');
    expect(out.isStale).toBe(false);
  });

  it('treats a present tradeState with missing tradeStatus as loading', () => {
    const out = computeStatusFreshness({
      ...BASE,
      dataLoading: true,
      lastTickMs: 1_700_000_000_000,
      nowMs: 1_700_000_000_000 + 999_999,
    });
    // lastTickMs is irrelevant while dataLoading=true.
    expect(out.freshnessStr).toContain('loading…');
    expect(out.isStale).toBe(false);
  });
});

describe('computeStatusFreshness — fresh payload', () => {
  it('renders real PnL + fees and no staleness badge when just-ticked', () => {
    const now = 1_700_000_000_000;
    const out = computeStatusFreshness({
      dataLoading: false,
      lastTickMs: now - 1_000, // 1s ago
      nowMs: now,
      realizedPnl: 12.34,
      realizedPnlPct: 2.5,
      totalFees: 0.56,
    });
    expect(out.pnlStr).toContain('+$12.34');
    expect(out.pnlPctStr).toContain('+2.50%');
    expect(out.feesStr).toBe('$0.56');
    expect(out.freshnessStr).toBe('');
    expect(out.isStale).toBe(false);
    expect(out.staleSec).toBe(1);
  });

  it('colors PnL red when negative and uses raw "-" sign', () => {
    const now = 1_700_000_000_000;
    const out = computeStatusFreshness({
      dataLoading: false,
      lastTickMs: now - 500,
      nowMs: now,
      realizedPnl: -4.2,
      realizedPnlPct: -0.75,
      totalFees: 1.0,
    });
    expect(out.pnlStr).toContain('{red-fg}');
    expect(out.pnlStr).toContain('-4.20');
    expect(out.pnlPctStr).toContain('{red-fg}');
    expect(out.pnlPctStr).toContain('-0.75%');
    expect(out.feesStr).toBe('$1.00');
    expect(out.freshnessStr).toBe('');
  });
});

describe('computeStatusFreshness — stale payload', () => {
  it('does not badge stale at exactly the threshold (strictly greater than)', () => {
    const now = 1_700_000_000_000;
    const out = computeStatusFreshness({
      ...BASE,
      dataLoading: false,
      lastTickMs: now - TRADE_STALE_AFTER_MS,
      nowMs: now,
    });
    expect(out.isStale).toBe(false);
    expect(out.freshnessStr).toBe('');
  });

  it('badges stale once age exceeds the threshold', () => {
    const now = 1_700_000_000_000;
    const out = computeStatusFreshness({
      ...BASE,
      dataLoading: false,
      lastTickMs: now - (TRADE_STALE_AFTER_MS + 42_000), // 52s past last tick
      nowMs: now,
    });
    expect(out.isStale).toBe(true);
    expect(out.staleSec).toBe(52);
    expect(out.freshnessStr).toContain('stale 52s');
  });

  it('renders real (stale) PnL so the operator can still see last-known numbers', () => {
    const now = 1_700_000_000_000;
    const out = computeStatusFreshness({
      dataLoading: false,
      lastTickMs: now - 30_000,
      nowMs: now,
      realizedPnl: 7.0,
      realizedPnlPct: 1.1,
      totalFees: 0.25,
    });
    // Stale means "the daemon hasn't updated recently", NOT "nuke all numbers".
    // The old values are still the best estimate — just badge them as stale.
    expect(out.pnlStr).toContain('+$7.00');
    expect(out.feesStr).toBe('$0.25');
    expect(out.freshnessStr).toContain('stale');
  });

  it('treats a fresh payload that lacks lastTickAt as non-stale', () => {
    const out = computeStatusFreshness({
      ...BASE,
      dataLoading: false,
      lastTickMs: null,
      nowMs: 1_700_000_000_000,
    });
    expect(out.isStale).toBe(false);
    expect(out.staleSec).toBe(0);
    expect(out.freshnessStr).toBe('');
  });

  it('clamps staleSec to 0 if lastTickMs is in the future (clock skew)', () => {
    const now = 1_700_000_000_000;
    const out = computeStatusFreshness({
      ...BASE,
      dataLoading: false,
      lastTickMs: now + 5_000,
      nowMs: now,
    });
    expect(out.staleSec).toBe(0);
    expect(out.isStale).toBe(false);
  });
});
