import { describe, expect, it } from 'vitest';
import { CircuitBreaker } from './circuit.js';

describe('CircuitBreaker', () => {
  it('starts closed and allows execution', () => {
    const cb = new CircuitBreaker();
    expect(cb.canExecute()).toBeNull();
    expect(cb.status().state).toBe('closed');
  });

  it('trips after N consecutive failures', () => {
    const cb = new CircuitBreaker({ config: { maxConsecutiveFailures: 3 } });
    cb.recordExecution({ filled: false });
    cb.recordExecution({ filled: false });
    expect(cb.canExecute()).toBeNull();
    cb.recordExecution({ filled: false });
    expect(cb.canExecute()).toMatch(/3 consecutive execution failures/);
  });

  it('a successful execution resets the consecutive-failure counter', () => {
    const cb = new CircuitBreaker({ config: { maxConsecutiveFailures: 3 } });
    cb.recordExecution({ filled: false });
    cb.recordExecution({ filled: false });
    cb.recordExecution({ filled: true });
    cb.recordExecution({ filled: false });
    cb.recordExecution({ filled: false });
    expect(cb.canExecute()).toBeNull(); // still 2, didn't hit 3
  });

  it('trips when realized daily loss exceeds the cap', () => {
    const cb = new CircuitBreaker({ config: { maxDailyLossUsd: 50 } });
    cb.recordExecution({ filled: true, realizedPnlUsd: -20 });
    cb.recordExecution({ filled: true, realizedPnlUsd: -25 });
    expect(cb.canExecute()).toBeNull();
    cb.recordExecution({ filled: true, realizedPnlUsd: -10 });
    expect(cb.canExecute()).toMatch(/daily loss/);
  });

  it('positive PnL does not count against the loss cap', () => {
    const cb = new CircuitBreaker({ config: { maxDailyLossUsd: 50 } });
    cb.recordExecution({ filled: true, realizedPnlUsd: +30 });
    cb.recordExecution({ filled: true, realizedPnlUsd: +30 });
    expect(cb.status().dailyLossUsd).toBe(0);
  });

  it('external trip() opens the breaker immediately', () => {
    const cb = new CircuitBreaker();
    cb.trip('gas spike 5x baseline');
    expect(cb.canExecute()).toMatch(/gas spike 5x/);
  });

  it('reset() closes the breaker and zeros all counters', () => {
    const cb = new CircuitBreaker({ config: { maxConsecutiveFailures: 2 } });
    cb.recordExecution({ filled: false });
    cb.recordExecution({ filled: false });
    expect(cb.canExecute()).toMatch(/consecutive/);
    cb.reset();
    expect(cb.canExecute()).toBeNull();
    expect(cb.status().consecutiveFailures).toBe(0);
    expect(cb.status().dailyLossUsd).toBe(0);
  });

  it('the first trip reason sticks — later trips do not overwrite it', () => {
    const cb = new CircuitBreaker();
    cb.trip('gas spike');
    cb.trip('wallet low');
    expect(cb.canExecute()).toMatch(/gas spike/);
  });

  it('rolls the daily loss counter on day boundary', () => {
    let now = Date.UTC(2026, 3, 14, 12, 0, 0); // noon UTC
    const cb = new CircuitBreaker({ now: () => now });
    cb.recordExecution({ filled: true, realizedPnlUsd: -40 });
    expect(cb.status().dailyLossUsd).toBe(40);
    // Next day noon UTC.
    now = Date.UTC(2026, 3, 15, 12, 0, 0);
    cb.recordExecution({ filled: true, realizedPnlUsd: -10 });
    expect(cb.status().dailyLossUsd).toBe(10);
  });

  it('status exposes the trip record with timestamp', () => {
    const cb = new CircuitBreaker({ now: () => 42 });
    cb.trip('test');
    const s = cb.status();
    expect(s.state).toBe('open');
    expect(s.trip?.at).toBe(42);
    expect(s.trip?.reason).toBe('test');
  });
});
