import { describe, it, expect } from 'vitest';
import {
  isAgentToken,
  isValidScope,
  sanitizeScopes,
  tokenHasScope,
  isTokenActive,
  symbolAllowed,
  checkAgentBudget,
  agentWindowStart,
  AGENT_TOKEN_PREFIX,
  type AgentTokenRow,
} from './agent-tokens.js';

const row = (over: Partial<AgentTokenRow> = {}): AgentTokenRow => ({
  id: 't1',
  user_id: 'u1',
  name: 'bot',
  token_hash: 'h',
  token_suffix: 'abcd',
  scopes: ['read', 'trade:crypto'],
  budget_usd: 100,
  budget_window: 'daily',
  allowed_symbols: null,
  revoked_at: null,
  last_used_at: null,
  created_at: '2026-06-18T00:00:00Z',
  ...over,
});

describe('token shape helpers', () => {
  it('recognizes the agent token prefix', () => {
    expect(isAgentToken(`${AGENT_TOKEN_PREFIX}xyz`)).toBe(true);
    expect(isAgentToken('eyJ...jwt')).toBe(false);
    expect(isAgentToken(null)).toBe(false);
  });

  it('validates scopes', () => {
    expect(isValidScope('trade:crypto')).toBe(true);
    expect(isValidScope('trade:everything')).toBe(false);
  });

  it('sanitizes scopes, defaulting to read', () => {
    expect(sanitizeScopes(['read', 'bogus', 'trade:crypto', 'read'])).toEqual(['read', 'trade:crypto']);
    expect(sanitizeScopes([])).toEqual(['read']);
    expect(sanitizeScopes('nope')).toEqual(['read']);
  });
});

describe('scope + state checks', () => {
  it('checks scope membership', () => {
    expect(tokenHasScope(row(), 'trade:crypto')).toBe(true);
    expect(tokenHasScope(row(), 'trade:equity')).toBe(false);
  });

  it('treats revoked tokens as inactive', () => {
    expect(isTokenActive(row())).toBe(true);
    expect(isTokenActive(row({ revoked_at: '2026-06-18T01:00:00Z' }))).toBe(false);
  });

  it('enforces the symbol allowlist (case-insensitive; empty = any)', () => {
    expect(symbolAllowed(row({ allowed_symbols: null }), 'BTC-USD')).toBe(true);
    expect(symbolAllowed(row({ allowed_symbols: [] }), 'BTC-USD')).toBe(true);
    expect(symbolAllowed(row({ allowed_symbols: ['btc-usd'] }), 'BTC-USD')).toBe(true);
    expect(symbolAllowed(row({ allowed_symbols: ['ETH-USD'] }), 'BTC-USD')).toBe(false);
  });
});

describe('checkAgentBudget', () => {
  it('allows an order within the remaining token budget', () => {
    const r = checkAgentBudget(row({ budget_usd: 100 }), 40, 50);
    expect(r.allowed).toBe(true);
    expect(r.remainingUsd).toBe(60);
  });

  it('rejects an order over the remaining budget', () => {
    const r = checkAgentBudget(row({ budget_usd: 100 }), 80, 50);
    expect(r.allowed).toBe(false);
    expect(r.remainingUsd).toBe(20);
  });

  it('rejects any trade when budget is 0', () => {
    const r = checkAgentBudget(row({ budget_usd: 0 }), 0, 1);
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('no trading budget');
  });

  it('handles string budgets from the DB', () => {
    const r = checkAgentBudget(row({ budget_usd: '100' }), 0, 50);
    expect(r.allowed).toBe(true);
    expect(r.budgetUsd).toBe(100);
  });
});

describe('agentWindowStart', () => {
  const tue = Date.UTC(2026, 5, 16, 9, 0, 0);
  it('daily/weekly/monthly align with the engine windows', () => {
    expect(agentWindowStart('daily', tue)).toBe(Date.UTC(2026, 5, 16));
    expect(agentWindowStart('weekly', tue)).toBe(Date.UTC(2026, 5, 15)); // Monday
    expect(agentWindowStart('monthly', tue)).toBe(Date.UTC(2026, 5, 1));
  });
});
