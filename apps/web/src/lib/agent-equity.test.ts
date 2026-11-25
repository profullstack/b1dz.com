import { beforeEach, describe, expect, it, vi } from 'vitest';

const daemonMock = vi.fn();
const spentMock = vi.fn();
vi.mock('@/lib/daemon-control', () => ({ daemonEquity: (...a: unknown[]) => daemonMock(...a) }));
vi.mock('./daemon-control', () => ({ daemonEquity: (...a: unknown[]) => daemonMock(...a) }));
vi.mock('./agent-tokens', () => ({ tokenSpentThisWindow: (...a: unknown[]) => spentMock(...a) }));

const { cancelAgentStockOrder, getAgentBrokerAccount, placeAgentStockOrder } = await import('./agent-equity');

/** A tiny admin client: records ledger inserts/deletes and action logs. */
function admin() {
  const ledger: Record<string, unknown>[] = [];
  const actions: Record<string, unknown>[] = [];
  let n = 0;
  return {
    ledger,
    actions,
    from(table: string) {
      if (table === 'agent_actions') return { insert: async (r: Record<string, unknown>) => void actions.push(r) };
      return {
        insert: (r: Record<string, unknown>) => ({
          select: () => ({
            single: async () => {
              const row = { id: `L${++n}`, ...r };
              ledger.push(row);
              return { data: { id: row.id }, error: null };
            },
          }),
        }),
        delete: () => ({
          eq: async (_c: string, id: string) => {
            const i = ledger.findIndex((x) => x.id === id);
            if (i >= 0) ledger.splice(i, 1);
            return { error: null };
          },
        }),
      };
    },
  };
}

function agent(over: { scopes?: string[]; budget_usd?: number; allowed_symbols?: string[] | null } = {}) {
  const a = admin();
  const token = { scopes: over.scopes ?? ['read', 'trade:equity'], budget_usd: over.budget_usd ?? 1000, budget_window: 'daily', allowed_symbols: over.allowed_symbols ?? null };
  return { a, agent: { admin: a, userId: 'u1', tokenId: 't1', scopes: token.scopes, token } as never };
}

const OK = { status: 200, body: { broker: 'alpaca', paper: true, result: { ok: true, orderId: 'o1', status: 'accepted', message: 'order o1 accepted' } } };

beforeEach(() => {
  daemonMock.mockReset().mockResolvedValue(OK);
  spentMock.mockReset().mockResolvedValue(0);
});

describe('agent stock orders', () => {
  it('needs the trade:equity scope', async () => {
    const { agent: ag, a } = agent({ scopes: ['read', 'trade:crypto'] });
    const r = await placeAgentStockOrder(ag, { symbol: 'AAPL', side: 'buy', notionalUsd: 100 });
    expect(r.status).toBe(403);
    expect(daemonMock).not.toHaveBeenCalled();
    expect(a.ledger).toHaveLength(0);
    expect((await cancelAgentStockOrder(ag, { orderId: 'o1' })).status).toBe(403);
  });

  it('refuses a symbol off the allowlist and a bad ticket', async () => {
    const { agent: ag } = agent({ allowed_symbols: ['SPY'] });
    expect((await placeAgentStockOrder(ag, { symbol: 'AAPL', side: 'buy', notionalUsd: 100 })).status).toBe(403);
    expect((await placeAgentStockOrder(ag, { symbol: 'SPY', side: 'buy' })).status).toBe(400);
    expect(daemonMock).not.toHaveBeenCalled();
  });

  it('refuses a market buy by share count: its cost is unknown', async () => {
    const { agent: ag } = agent();
    const r = await placeAgentStockOrder(ag, { symbol: 'AAPL', side: 'buy', qty: 5 });
    expect(r.status).toBe(400);
    expect(String(r.body.error)).toMatch(/known maximum cost/);
    expect(daemonMock).not.toHaveBeenCalled();
  });

  it('charges a dollar buy to the budget and sends it', async () => {
    const { agent: ag, a } = agent();
    const r = await placeAgentStockOrder(ag, { symbol: 'aapl', side: 'buy', notionalUsd: 250, broker: 'Alpaca', userId: 'someone-else' });
    expect(r).toMatchObject({ status: 200, body: { placed: 'Buy $250 of AAPL at market, DAY', orderId: 'o1', paper: true, chargedToBudgetUsd: 250 } });
    expect(daemonMock).toHaveBeenCalledWith('order', 'u1', { symbol: 'AAPL', side: 'buy', type: 'market', tif: 'day', notionalUsd: 250, broker: 'alpaca' });
    expect(a.ledger).toEqual([{ id: 'L1', user_id: 'u1', source: 'agent', exchange: 'alpaca', pair: 'AAPL', usd: 250, agent_token_id: 't1' }]);
    expect(a.actions.at(-1)).toMatchObject({ action: 'place_stock_order', ok: true });
  });

  it('charges a limit buy at shares x limit price', async () => {
    const { agent: ag, a } = agent();
    await placeAgentStockOrder(ag, { symbol: 'AAPL', side: 'buy', qty: 3, type: 'limit', limitPrice: 190 });
    expect(a.ledger[0].usd).toBe(570);
  });

  it('stops at the budget, counting what is already spent', async () => {
    spentMock.mockResolvedValue(900);
    const { agent: ag, a } = agent();
    const r = await placeAgentStockOrder(ag, { symbol: 'AAPL', side: 'buy', notionalUsd: 250 });
    expect(r.status).toBe(402);
    expect(r.body.remainingUsd).toBe(100);
    expect(daemonMock).not.toHaveBeenCalled();
    expect(a.ledger).toHaveLength(0);
    const zero = agent({ budget_usd: 0 });
    expect((await placeAgentStockOrder(zero.agent, { symbol: 'AAPL', side: 'buy', notionalUsd: 1 })).status).toBe(402);
  });

  it('releases the budget when the broker refuses, and passes a lock through', async () => {
    const { agent: ag, a } = agent();
    daemonMock.mockResolvedValue({ status: 422, body: { error: 'insufficient buying power', result: { ok: false, message: 'insufficient buying power' } } });
    const r = await placeAgentStockOrder(ag, { symbol: 'AAPL', side: 'buy', notionalUsd: 250 });
    expect(r).toMatchObject({ status: 422, body: { error: 'insufficient buying power' } });
    expect(a.ledger).toHaveLength(0);
    daemonMock.mockResolvedValue({ status: 423, body: { locked: true, error: 'Trading is locked.' } });
    const locked = await placeAgentStockOrder(ag, { symbol: 'AAPL', side: 'buy', notionalUsd: 250 });
    expect(locked).toMatchObject({ status: 423, body: { locked: true } });
    expect(a.ledger).toHaveLength(0);
  });

  it('never answers a broker confirmation for the agent', async () => {
    const { agent: ag, a } = agent();
    daemonMock.mockResolvedValue({ status: 200, body: { result: { ok: false, message: 'Price is far from the market.', needsConfirm: { id: 'C1' } } } });
    const r = await placeAgentStockOrder(ag, { symbol: 'AAPL', side: 'buy', qty: 1, type: 'limit', limitPrice: 1 });
    expect(r.status).toBe(409);
    expect(String(r.body.error)).toMatch(/Nothing was sent/);
    expect(a.ledger).toHaveLength(0);
    expect(daemonMock).toHaveBeenCalledTimes(1); // no confirm call
  });

  it('keeps the charge when the outcome is unknown', async () => {
    const { agent: ag, a } = agent();
    daemonMock.mockResolvedValue({ status: 504, body: { unknown: true, error: 'timeout' } });
    const r = await placeAgentStockOrder(ag, { symbol: 'AAPL', side: 'buy', notionalUsd: 250 });
    expect(r.status).toBe(504);
    expect(a.ledger).toHaveLength(1);
  });

  it('sells without touching the budget', async () => {
    const { agent: ag, a } = agent({ budget_usd: 0 });
    const r = await placeAgentStockOrder(ag, { symbol: 'AAPL', side: 'sell', qty: 2 });
    expect(r.status).toBe(200);
    expect(a.ledger).toHaveLength(0);
    expect(spentMock).not.toHaveBeenCalled();
  });

  it('reads the account and cancels by id', async () => {
    const { agent: ag } = agent();
    daemonMock.mockResolvedValue({ status: 200, body: { broker: 'alpaca', buyingPowerUsd: 5 } });
    expect((await getAgentBrokerAccount(ag, 'ALPACA')).body).toEqual({ broker: 'alpaca', buyingPowerUsd: 5 });
    expect(daemonMock).toHaveBeenLastCalledWith('account', 'u1', { broker: 'alpaca' });
    expect((await cancelAgentStockOrder(ag, { orderId: 'o9' })).body).toMatchObject({ canceled: 'o9' });
    expect((await cancelAgentStockOrder(ag, {})).status).toBe(400);
  });
});
