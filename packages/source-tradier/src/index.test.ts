import { describe, it, expect, vi } from 'vitest';
import { TradierConnector, createTradierConnector, mapTradierStatus } from './index.js';

function mock(routes: Record<string, unknown>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const key = Object.keys(routes).find((k) => url.includes(k));
    if (!key) return new Response('not found', { status: 404 });
    const body = routes[key];
    return body instanceof Response ? body : new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;
  const connector = new TradierConnector({ accessToken: 't', accountId: 'A1', fetchImpl });
  return { connector, calls };
}

describe('mapTradierStatus', () => {
  it('maps to the five contract states', () => {
    expect(mapTradierStatus('filled')).toBe('filled');
    expect(mapTradierStatus('partially_filled')).toBe('partial');
    expect(mapTradierStatus('rejected')).toBe('rejected');
    expect(mapTradierStatus('canceled')).toBe('canceled');
    expect(mapTradierStatus('ok')).toBe('accepted');
    expect(mapTradierStatus('open')).toBe('accepted');
  });
});

describe('TradierConnector', () => {
  it('defaults to the sandbox host and tags paper', () => {
    const c = createTradierConnector({ accessToken: 't', accountId: 'A1' });
    expect(c.manifest.kind).toBe('broker');
    expect(c.manifest.capabilities).toContain('feature:paper');
  });

  it('maps premarket clock state to pre', async () => {
    const { connector } = mock({ '/v1/markets/clock': { clock: { state: 'premarket' } } });
    expect((await connector.session('AAPL')).status).toBe('pre');
  });

  it('reads stock buying power', async () => {
    const { connector } = mock({ '/balances': { balances: { margin: { stock_buying_power: 5000 } } } });
    expect(await connector.buyingPowerUsd()).toBe(5000);
  });

  it('handles the no-positions sentinel', async () => {
    const { connector } = mock({ '/positions': { positions: 'null' } });
    expect(await connector.positions()).toEqual([]);
  });

  it('maps a single position (avgEntry from cost basis)', async () => {
    const { connector } = mock({ '/positions': { positions: { position: { symbol: 'AAPL', quantity: 4, cost_basis: 800 } } } });
    const pos = await connector.positions();
    expect(pos[0]).toMatchObject({ symbol: 'AAPL', qty: 4, avgEntry: 200, currency: 'USD' });
  });

  it('parses a quote', async () => {
    const { connector } = mock({ '/v1/markets/quotes': { quotes: { quote: { bid: 199, ask: 201, last: 200 } } } });
    const q = await connector.quote('AAPL');
    expect(q).toMatchObject({ bid: 199, ask: 201, last: 200 });
  });

  it('rejects a limit order with no price before calling the API', async () => {
    const { connector, calls } = mock({});
    const r = await connector.placeOrder({ symbol: 'AAPL', side: 'buy', qty: 1, type: 'limit', tif: 'day' });
    expect(r.ok).toBe(false);
    expect(calls.length).toBe(0);
  });

  it('converts notional to whole shares via the quote', async () => {
    const { connector, calls } = mock({
      '/v1/markets/quotes': { quotes: { quote: { bid: 99, ask: 101, last: 100 } } },
      '/orders': { order: { id: 42, status: 'ok' } },
    });
    const r = await connector.placeOrder({ symbol: 'AAPL', side: 'buy', notionalUsd: 550, type: 'market', tif: 'day' });
    expect(r.ok).toBe(true);
    expect(r.orderId).toBe('42');
    const body = (calls.at(-1)!.init!.body as string);
    expect(body).toContain('quantity=5'); // floor(550/100)
  });

  it('cancels an order', async () => {
    const { connector } = mock({ '/orders/': new Response('{}', { status: 200 }) });
    const r = await connector.cancelOrder('42');
    expect(r).toMatchObject({ ok: true, status: 'canceled', orderId: '42' });
  });
});
