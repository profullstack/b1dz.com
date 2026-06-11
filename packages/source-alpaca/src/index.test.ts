import { describe, it, expect, vi } from 'vitest';
import { AlpacaConnector, createAlpacaConnector, mapOrderStatus } from './index.js';
import { AlpacaClient } from './alpaca-client.js';
import type { AlpacaConfig } from './alpaca-client.js';

/** Build a connector whose HTTP layer is a scripted fetch mock. */
function mockConnector(routes: Record<string, unknown>, opts: Partial<AlpacaConfig> = {}) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const key = Object.keys(routes).find((k) => url.includes(k));
    if (!key) return new Response('not found', { status: 404 });
    const body = routes[key];
    if (body instanceof Response) return body;
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;
  const client = new AlpacaClient({ keyId: 'k', secretKey: 's', fetchImpl, ...opts });
  return { connector: new AlpacaConnector(client), calls, fetchImpl };
}

describe('mapOrderStatus', () => {
  it('maps Alpaca states to the five contract states', () => {
    expect(mapOrderStatus('filled')).toBe('filled');
    expect(mapOrderStatus('partially_filled')).toBe('partial');
    expect(mapOrderStatus('rejected')).toBe('rejected');
    expect(mapOrderStatus('canceled')).toBe('canceled');
    expect(mapOrderStatus('expired')).toBe('canceled');
    expect(mapOrderStatus('new')).toBe('accepted');
    expect(mapOrderStatus('pending_new')).toBe('accepted');
    expect(mapOrderStatus('weird_future_state')).toBe('accepted');
  });
});

describe('AlpacaConnector manifest', () => {
  it('tags paper capability only on paper', () => {
    const paper = createAlpacaConnector({ keyId: 'k', secretKey: 's' });
    expect(paper.manifest.capabilities).toContain('feature:paper');
    const live = createAlpacaConnector({ keyId: 'k', secretKey: 's', paper: false });
    expect(live.manifest.capabilities).not.toContain('feature:paper');
    expect(live.manifest.kind).toBe('broker');
  });
});

describe('AlpacaConnector reads', () => {
  it('buyingPowerUsd parses account', async () => {
    const { connector } = mockConnector({ '/v2/account': { buying_power: '12345.67' } });
    expect(await connector.buyingPowerUsd()).toBe(12345.67);
  });

  it('positions map to BrokerPosition', async () => {
    const { connector } = mockConnector({
      '/v2/positions': [
        { symbol: 'AAPL', qty: '3', avg_entry_price: '180.5', market_value: '600', exchange: 'NASDAQ' },
      ],
    });
    const pos = await connector.positions();
    expect(pos).toEqual([
      { symbol: 'AAPL', qty: 3, avgEntry: 180.5, marketValue: 600, currency: 'USD', exchange: 'NASDAQ' },
    ]);
  });

  it('quote combines latest quote + trade', async () => {
    const { connector } = mockConnector({
      '/quotes/latest': { quote: { bp: 199.9, ap: 200.1, t: '2026-06-11T14:30:00Z' } },
      '/trades/latest': { trade: { p: 200.05, t: '2026-06-11T14:30:01Z' } },
    });
    const q = await connector.quote('AAPL');
    expect(q.bid).toBe(199.9);
    expect(q.ask).toBe(200.1);
    expect(q.last).toBe(200.05);
    expect(q.ts).toBe(Date.parse('2026-06-11T14:30:00Z'));
  });

  it('quote falls back to midpoint when no trade print', async () => {
    const { connector } = mockConnector({
      '/quotes/latest': { quote: { bp: 100, ap: 102, t: '2026-06-11T14:30:00Z' } },
      '/trades/latest': new Response('no trade', { status: 404 }),
    });
    const q = await connector.quote('AAPL');
    expect(q.last).toBe(101);
  });
});

describe('AlpacaConnector placeOrder', () => {
  it('rejects a limit order with no price before hitting the API', async () => {
    const { connector, fetchImpl } = mockConnector({});
    const r = await connector.placeOrder({ symbol: 'AAPL', side: 'buy', qty: 1, type: 'limit', tif: 'day' });
    expect(r.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects an order with neither qty nor notional', async () => {
    const { connector, fetchImpl } = mockConnector({});
    const r = await connector.placeOrder({ symbol: 'AAPL', side: 'buy', type: 'market', tif: 'day' });
    expect(r.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('sends notional (not qty) when notionalUsd is supplied', async () => {
    const { connector, calls } = mockConnector({
      '/v2/orders': { id: 'o1', status: 'accepted', filled_qty: '0', filled_avg_price: null, qty: null },
    });
    const r = await connector.placeOrder({
      symbol: 'AAPL', side: 'buy', notionalUsd: 500, qty: 99, type: 'market', tif: 'day',
    });
    expect(r.ok).toBe(true);
    expect(r.status).toBe('accepted');
    const body = JSON.parse((calls.at(-1)!.init!.body as string));
    expect(body.notional).toBe('500');
    expect(body.qty).toBeUndefined();
  });

  it('maps a filled order result', async () => {
    const { connector } = mockConnector({
      '/v2/orders': { id: 'o2', status: 'filled', filled_qty: '2', filled_avg_price: '200.25', qty: '2' },
    });
    const r = await connector.placeOrder({ symbol: 'AAPL', side: 'buy', qty: 2, type: 'market', tif: 'day' });
    expect(r).toMatchObject({ ok: true, status: 'filled', fillPrice: 200.25, filledQty: 2, orderId: 'o2' });
  });

  it('surfaces an API rejection as ok:false', async () => {
    const { connector } = mockConnector({
      '/v2/orders': new Response('insufficient buying power', { status: 403 }),
    });
    const r = await connector.placeOrder({ symbol: 'AAPL', side: 'buy', qty: 1, type: 'market', tif: 'day' });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('403');
  });
});

describe('AlpacaConnector cancelOrder', () => {
  it('returns canceled on success', async () => {
    const { connector } = mockConnector({ '/v2/orders/': new Response(null, { status: 204 }) });
    const r = await connector.cancelOrder('o9');
    expect(r).toMatchObject({ ok: true, status: 'canceled', orderId: 'o9' });
  });
});

describe('paper host selection', () => {
  it('uses the paper host by default and live when paper:false', async () => {
    const { connector, calls } = mockConnector({ '/v2/account': { buying_power: '1' } });
    await connector.buyingPowerUsd();
    expect(calls[0].url).toContain('paper-api.alpaca.markets');

    const live = mockConnector({ '/v2/account': { buying_power: '1' } }, { paper: false });
    await live.connector.buyingPowerUsd();
    expect(live.calls[0].url).toContain('api.alpaca.markets');
    expect(live.calls[0].url).not.toContain('paper-api');
  });
});
