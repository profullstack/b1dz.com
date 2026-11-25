import { describe, expect, it, vi } from 'vitest';
import type { BrokerConnectorPlugin, BrokerOrderArgs, BrokerOrderResult } from '@b1dz/core';
import { createManualTrade, type ManualTradeDeps } from './manual-trade.js';
import type { LinkedBroker } from './brokers.js';
import type { UserConfig, UserConfigState } from './user-config.js';

const U = '00000000-0000-4000-8000-0000000000aa';

function cfg(plain: Record<string, string> = {}): UserConfig {
  return {
    userId: U,
    getSecret: () => undefined,
    getPlain: (k) => plain[k],
    getUserSecret: () => undefined,
    getUserPlain: (k) => plain[k],
    getNumber: () => undefined,
    getBool: () => undefined,
  };
}

function broker(id: string, over: Partial<LinkedBroker> = {}, conn: Partial<BrokerConnectorPlugin> = {}): LinkedBroker & { placed: BrokerOrderArgs[] } {
  const placed: BrokerOrderArgs[] = [];
  const connector = {
    manifest: { id, kind: 'broker', version: '0', name: id, capabilities: [] },
    broker: id,
    markets: ['us'],
    session: async () => ({ status: 'open', timezone: 'America/New_York' }),
    buyingPowerUsd: async () => 5000,
    positions: async () => [{ symbol: 'AAPL', qty: 10, avgEntry: 100, marketValue: 1900, currency: 'USD' }],
    quote: async () => ({ bid: 189.9, ask: 190.1, last: 190, ts: 1 }),
    placeOrder: async (a: BrokerOrderArgs): Promise<BrokerOrderResult> => {
      placed.push(a);
      return { ok: true, message: 'order 1 accepted', orderId: '1', status: 'accepted' };
    },
    cancelOrder: async (orderId: string): Promise<BrokerOrderResult> => ({ ok: true, message: 'canceled', orderId, status: 'canceled' }),
    ...conn,
  } as unknown as BrokerConnectorPlugin;
  return { id, label: id, paper: true, supportsFractional: true, connector, placed, ...over };
}

function setup(list: LinkedBroker[], opts: { status?: UserConfigState['status']; plain?: Record<string, string> } = {}) {
  const log = vi.fn();
  const deps: ManualTradeDeps = {
    loadState: async () => ({ status: opts.status ?? 'unlocked', config: cfg(opts.plain) }),
    refreshTokens: async () => false,
    brokers: () => list,
    log,
  };
  return { trade: createManualTrade(deps), log };
}

describe('manual trade', () => {
  it('refuses everything while the user is locked', async () => {
    const b = broker('alpaca');
    const { trade } = setup([b], { status: 'locked' });
    for (const action of ['account', 'order', 'cancel', 'confirm'] as const) {
      const r = await trade(action, U, { symbol: 'AAPL', side: 'buy', qty: 1 });
      expect(r.status).toBe(423);
      expect(r.body.locked).toBe(true);
    }
    expect(b.placed).toHaveLength(0);
  });

  it('reports no linked broker as an empty account, and a 409 for an order', async () => {
    const { trade } = setup([]);
    expect(await trade('account', U, {})).toEqual({ status: 200, body: { brokers: [] } });
    expect((await trade('order', U, { symbol: 'AAPL', side: 'buy', qty: 1 })).status).toBe(409);
  });

  it('returns the account for the chosen broker', async () => {
    const { trade } = setup([broker('alpaca'), broker('moomoo', { paper: false, supportsFractional: false })], { plain: { TERMINAL_BROKER: 'moomoo' } });
    const r = await trade('account', U, {});
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ broker: 'moomoo', paper: false, buyingPowerUsd: 5000, maxOrderUsd: 10_000, session: 'open', ordersSupported: false });
    expect(r.body.brokers).toHaveLength(2);
    expect((await trade('account', U, { broker: 'alpaca' })).body).toMatchObject({ broker: 'alpaca', paper: true, maxOrderUsd: null });
    expect((await trade('account', U, { broker: 'schwab' })).status).toBe(404);
  });

  it('keeps the broker list usable when the link is broken', async () => {
    const { trade } = setup([broker('moomoo', {}, { buyingPowerUsd: async () => { throw new Error('moomoo rejected the access token: reconnect moomoo in Settings'); } })]);
    const r = await trade('account', U, {});
    expect(r.status).toBe(200);
    expect(r.body.error).toMatch(/reconnect moomoo/);
    expect(r.body.brokers).toHaveLength(1);
  });

  it('places a valid paper order and logs it without secrets', async () => {
    const b = broker('alpaca');
    const { trade, log } = setup([b]);
    const r = await trade('order', U, { symbol: 'aapl', side: 'buy', notionalUsd: 250_000 });
    expect(r.status).toBe(200); // paper: no dollar cap
    expect(b.placed).toEqual([{ symbol: 'AAPL', side: 'buy', type: 'market', tif: 'day', notionalUsd: 250_000 }]);
    expect(log.mock.calls[0][0]).toContain('paper "Buy $250,000 of AAPL at market, DAY" -> ok 1');
  });

  it('rejects a bad ticket before touching the broker', async () => {
    const b = broker('alpaca');
    const { trade } = setup([b]);
    expect((await trade('order', U, { symbol: 'AAPL', side: 'buy' })).status).toBe(400);
    expect((await trade('order', U, { symbol: 'BTC-USD', side: 'buy', qty: 1 })).status).toBe(400);
    expect(b.placed).toHaveLength(0);
  });

  it('caps a live order and refuses one it cannot price', async () => {
    const b = broker('alpaca', { paper: false });
    const { trade } = setup([b]);
    const over = await trade('order', U, { symbol: 'AAPL', side: 'buy', qty: 100 }); // 100 x $190 = $19,000
    expect(over.status).toBe(422);
    expect(over.body.error).toMatch(/\$19,000 is over your \$10,000 limit/);
    expect((await trade('order', U, { symbol: 'AAPL', side: 'buy', qty: 10 })).status).toBe(200);
    expect((await trade('order', U, { symbol: 'AAPL', side: 'buy', qty: 100, type: 'limit', limitPrice: 50 })).status).toBe(200); // $5,000
    expect(b.placed).toHaveLength(2);

    const blind = broker('alpaca', { paper: false }, { quote: async () => { throw new Error('no data'); } });
    const r = await setup([blind]).trade('order', U, { symbol: 'AAPL', side: 'buy', qty: 1 });
    expect(r.status).toBe(422);
    expect(r.body.error).toMatch(/cannot be checked/);
    expect(blind.placed).toHaveLength(0);
  });

  it('honours a raised live cap', async () => {
    const b = broker('alpaca', { paper: false });
    const { trade } = setup([b], { plain: { TERMINAL_MAX_ORDER_USD: '25000' } });
    expect((await trade('order', U, { symbol: 'AAPL', side: 'buy', qty: 100 })).status).toBe(200);
  });

  it('never sells more than is held', async () => {
    const b = broker('alpaca');
    const { trade } = setup([b]);
    expect((await trade('order', U, { symbol: 'AAPL', side: 'sell', qty: 11 })).body.error).toMatch(/You hold 10 AAPL/);
    expect((await trade('order', U, { symbol: 'MSFT', side: 'sell', qty: 1 })).body.error).toMatch(/hold no MSFT/);
    expect(b.placed).toHaveLength(0);
    expect((await trade('order', U, { symbol: 'AAPL', side: 'sell', qty: 10 })).status).toBe(200);
    const blind = broker('alpaca', {}, { positions: async () => { throw new Error('down'); } });
    expect((await setup([blind]).trade('order', U, { symbol: 'AAPL', side: 'sell', qty: 1 })).status).toBe(502);
    expect(blind.placed).toHaveLength(0);
  });

  it('refuses fractional shares where the broker has none', async () => {
    const b = broker('moomoo', { supportsFractional: false });
    const r = await setup([b]).trade('order', U, { symbol: 'AAPL', side: 'buy', qty: 1.5 });
    expect(r.status).toBe(422);
    expect(r.body.error).toMatch(/whole shares/);
  });

  it('passes a broker refusal and a confirmation request through', async () => {
    const refuse = broker('alpaca', {}, { placeOrder: async () => ({ ok: false, message: 'insufficient buying power', status: 'rejected' }) });
    const r = await setup([refuse]).trade('order', U, { symbol: 'AAPL', side: 'buy', qty: 1 });
    expect(r).toMatchObject({ status: 422, body: { error: 'insufficient buying power' } });

    const confirmOrder = vi.fn(async () => ({ ok: true, message: 'order 9 submitted', orderId: '9', status: 'accepted' as const }));
    const ask = broker('moomoo', { paper: false, supportsFractional: false }, {
      placeOrder: async () => ({ ok: false, message: 'Price is far from the market.', needsConfirm: { id: 'C1' } }),
      confirmOrder,
    });
    const { trade } = setup([ask]);
    const first = await trade('order', U, { symbol: 'AAPL', side: 'buy', qty: 1 });
    expect(first.status).toBe(200);
    expect(first.body.result).toMatchObject({ ok: false, needsConfirm: { id: 'C1' } });
    const second = await trade('confirm', U, { confirmId: 'C1' });
    expect(second.status).toBe(200);
    expect(confirmOrder).toHaveBeenCalledWith('C1');
    expect((await setup([broker('alpaca')]).trade('confirm', U, { confirmId: 'C1' })).status).toBe(400);
  });

  it('cancels by order id', async () => {
    const { trade } = setup([broker('alpaca')]);
    expect((await trade('cancel', U, { orderId: 'abc' })).status).toBe(200);
    expect((await trade('cancel', U, {})).status).toBe(400);
  });
});
