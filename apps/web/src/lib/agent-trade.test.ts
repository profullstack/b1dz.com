import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentTokenRow } from '@b1dz/core';

// tokenSpentThisWindow hits the DB via createAdminSupabase — mock it so the
// per-token budget math is driven by the test.
const tokenSpentMock = vi.fn();
vi.mock('./agent-tokens', () => ({
  tokenSpentThisWindow: (...args: unknown[]) => tokenSpentMock(...args),
}));

import { placeAgentOrder, getAgentBudget, getAgentQuote } from './agent-trade.js';
import type { AuthedAgent } from './api-auth.js';

/** Minimal fake admin client capturing source_state reads/writes + audit inserts. */
function makeAdmin(initialQueue: unknown[] = [], cryptoPayload: Record<string, unknown> | null = null) {
  const state = { queue: initialQueue, upserts: [] as Array<Record<string, unknown>>, actions: [] as Array<Record<string, unknown>> };
  const admin = {
    from(table: string) {
      if (table === 'agent_actions') {
        return { insert: async (row: Record<string, unknown>) => { state.actions.push(row); return { error: null }; } };
      }
      // source_state
      return {
        select: () => ({
          eq: () => ({
            eq: (_c: string, sourceId: string) => ({
              maybeSingle: async () => {
                if (sourceId === 'agent-orders') return { data: { payload: { queue: state.queue } }, error: null };
                return { data: cryptoPayload ? { payload: cryptoPayload } : null, error: null };
              },
            }),
          }),
        }),
        upsert: async (row: Record<string, unknown>) => {
          state.upserts.push(row);
          const payload = row.payload as { queue?: unknown[] } | undefined;
          if (payload?.queue) state.queue = payload.queue;
          return { error: null };
        },
      };
    },
  };
  return { admin, state };
}

const token = (over: Partial<AgentTokenRow> = {}): AgentTokenRow => ({
  id: 'tok-1',
  user_id: 'user-1',
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

function agent(over: Partial<AgentTokenRow> = {}, admin = makeAdmin().admin): AuthedAgent {
  const t = token(over);
  return { admin: admin as never, userId: t.user_id, tokenId: t.id, scopes: t.scopes, token: t };
}

describe('placeAgentOrder (contract)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tokenSpentMock.mockResolvedValue(0);
  });

  it('enqueues a valid buy within budget (202 accepted)', async () => {
    const { admin, state } = makeAdmin();
    const res = await placeAgentOrder(agent({}, admin), { pair: 'BTC-USD', usd: 50, idempotencyKey: 'k1' });
    expect(res.status).toBe(202);
    expect(res.body.status).toBe('accepted');
    expect(res.body.remainingBudgetUsd).toBe(50);
    // enqueued exactly one order
    expect(state.queue).toHaveLength(1);
    expect((state.queue[0] as { pair: string }).pair).toBe('BTC-USD');
    // audited
    expect(state.actions.some((a) => a.action === 'place_order' && a.ok === true)).toBe(true);
  });

  it('rejects when the token lacks trade:crypto scope (403)', async () => {
    const res = await placeAgentOrder(agent({ scopes: ['read'] }), { pair: 'BTC-USD', usd: 10 });
    expect(res.status).toBe(403);
    expect(String(res.body.error)).toMatch(/scope/);
  });

  it('rejects a symbol outside the allowlist (403)', async () => {
    const res = await placeAgentOrder(agent({ allowed_symbols: ['ETH-USD'] }), { pair: 'BTC-USD', usd: 10 });
    expect(res.status).toBe(403);
    expect(String(res.body.error)).toMatch(/allowed symbols/);
  });

  it('rejects an order over the remaining per-token budget (402)', async () => {
    tokenSpentMock.mockResolvedValue(80);
    const res = await placeAgentOrder(agent({ budget_usd: 100 }), { pair: 'BTC-USD', usd: 50 });
    expect(res.status).toBe(402);
    expect(res.body.remainingUsd).toBe(20);
  });

  it('rejects a zero-budget token (402)', async () => {
    const res = await placeAgentOrder(agent({ budget_usd: 0 }), { pair: 'BTC-USD', usd: 1 });
    expect(res.status).toBe(402);
  });

  it('validates pair + positive usd (400)', async () => {
    expect((await placeAgentOrder(agent(), { pair: '', usd: 10 })).status).toBe(400);
    expect((await placeAgentOrder(agent(), { pair: 'BTC-USD', usd: 0 })).status).toBe(400);
  });

  it('is idempotent on the idempotency key (no double-enqueue)', async () => {
    const { admin, state } = makeAdmin([
      { idempotencyKey: 'dup', tokenId: 'tok-1', pair: 'BTC-USD', exchange: null, usd: 50, side: 'buy', enqueuedAt: 'x' },
    ]);
    const res = await placeAgentOrder(agent({}, admin), { pair: 'BTC-USD', usd: 50, idempotencyKey: 'dup' });
    expect(res.status).toBe(200);
    expect(res.body.duplicate).toBe(true);
    expect(state.queue).toHaveLength(1); // unchanged
  });

  it('normalizes the pair to uppercase', async () => {
    const { admin, state } = makeAdmin();
    await placeAgentOrder(agent({}, admin), { pair: 'btc-usd', usd: 10, idempotencyKey: 'k' });
    expect((state.queue[0] as { pair: string }).pair).toBe('BTC-USD');
  });
});

describe('getAgentBudget (contract)', () => {
  beforeEach(() => { vi.clearAllMocks(); });
  it('reports budget/spent/remaining for the window', async () => {
    tokenSpentMock.mockResolvedValue(30);
    const res = await getAgentBudget(agent({ budget_usd: 100, budget_window: 'weekly' }));
    expect(res.body).toMatchObject({ budgetUsd: 100, spentUsd: 30, remainingUsd: 70, window: 'weekly' });
  });
});

describe('getAgentQuote (contract)', () => {
  it('returns the live price when the pair is in the active set', async () => {
    const { admin } = makeAdmin([], { trade: { positions: [{ pair: 'BTC-USD', exchange: 'kraken', currentPrice: 65000 }] } });
    const res = await getAgentQuote(agent({}, admin), 'btc-usd');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ pair: 'BTC-USD', exchange: 'kraken', price: 65000 });
  });

  it('404s when the pair has no live price', async () => {
    const { admin } = makeAdmin([], { trade: { positions: [] } });
    const res = await getAgentQuote(agent({}, admin), 'DOGE-USD');
    expect(res.status).toBe(404);
  });
});
