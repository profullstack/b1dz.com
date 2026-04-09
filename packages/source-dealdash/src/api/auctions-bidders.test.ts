/**
 * Contract tests for getBidders + historyContainsUser — the tiny helpers
 * that project visible bidding history into the "how many people are
 * fighting on this auction?" count.
 */

import { describe, it, expect } from 'vitest';
import { getBidders, historyContainsUser } from './auctions.js';

const mk = (...users: string[]): [string, number, string][] =>
  users.map((u, i) => [`${i + 1}.00`, 1_700_000_000 + i, u] as [string, number, string]);

describe('getBidders', () => {
  it('returns 0 on empty / missing history', () => {
    expect(getBidders(undefined)).toBe(0);
    expect(getBidders([])).toBe(0);
  });

  it('returns distinct user count', () => {
    expect(getBidders(mk('alice'))).toBe(1);
    expect(getBidders(mk('alice', 'bob', 'alice'))).toBe(2);
    expect(getBidders(mk('alice', 'bob', 'carol', 'alice', 'bob'))).toBe(3);
  });

  it('ignores empty username entries', () => {
    expect(getBidders(mk('alice', '', 'bob'))).toBe(2);
  });
});

describe('historyContainsUser', () => {
  it('finds the user in the history', () => {
    expect(historyContainsUser(mk('alice', 'bob'), 'bob')).toBe(true);
  });
  it('returns false when absent', () => {
    expect(historyContainsUser(mk('alice', 'bob'), 'carol')).toBe(false);
  });
  it('returns false on empty inputs', () => {
    expect(historyContainsUser(undefined, 'alice')).toBe(false);
    expect(historyContainsUser([], 'alice')).toBe(false);
    expect(historyContainsUser(mk('alice'), '')).toBe(false);
  });
});
