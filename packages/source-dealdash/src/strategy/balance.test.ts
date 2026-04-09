/**
 * Contract test for the bid-balance hysteresis state machine. The whole
 * point of this is to prevent flapping when low-balance focus mode briefly
 * frees bids by cancelling fights.
 */

import { describe, it, expect } from 'vitest';
import { makeBalanceMode, applyBalance } from './balance.js';

describe('balance state machine', () => {
  it('starts not in low mode', () => {
    expect(makeBalanceMode().inLow).toBe(false);
  });

  it('enters low mode at the enter threshold', () => {
    const s0 = makeBalanceMode();
    const t1 = applyBalance(s0, 1000);
    expect(t1.event).toBe('entered');
    expect(t1.next.inLow).toBe(true);
  });

  it('does NOT exit when balance briefly bumps above the enter threshold', () => {
    let state = makeBalanceMode();
    state = applyBalance(state, 800).next;
    expect(state.inLow).toBe(true);
    // Bumps to 1200 — above enter (1000) but below exit (1500). Stays in low mode.
    const t = applyBalance(state, 1200);
    expect(t.event).toBeNull();
    expect(t.next.inLow).toBe(true);
  });

  it('exits low mode at the exit threshold', () => {
    let state = makeBalanceMode();
    state = applyBalance(state, 800).next;
    const t = applyBalance(state, 1500);
    expect(t.event).toBe('exited');
    expect(t.next.inLow).toBe(false);
  });

  it('does not re-enter immediately after exiting until balance drops again', () => {
    let state = makeBalanceMode();
    state = applyBalance(state, 800).next;
    state = applyBalance(state, 1500).next;
    expect(state.inLow).toBe(false);
    // Sit at 1200 — between thresholds. No transition.
    const t = applyBalance(state, 1200);
    expect(t.event).toBeNull();
    expect(t.next.inLow).toBe(false);
  });

  it('honors custom thresholds', () => {
    const s = makeBalanceMode({ enterAt: 500, exitAt: 800 });
    expect(applyBalance(s, 600).event).toBeNull();
    expect(applyBalance(s, 500).event).toBe('entered');
  });
});
