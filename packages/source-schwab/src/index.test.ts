import { describe, it, expect, vi } from 'vitest';
import { SchwabConnector, mapSchwabStatus } from './index.js';

function mock(routes: Record<string, unknown>, headers?: Record<string, string>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const key = Object.keys(routes).find((k) => url.includes(k));
    if (!key) return new Response('not found', { status: 404 });
    const body = routes[key];
    if (body instanceof Response) return body;
    return new Response(JSON.stringify(body), { status: 200, headers });
  }) as unknown as typeof fetch;
  const connector = new SchwabConnector({ accessToken: 't', accountHash: 'H1', fetchImpl });
  return { connector, calls };
}

describe('mapSchwabStatus', () => {
  it('maps Schwab states', () => {
    expect(mapSchwabStatus('FILLED')).toBe('filled');
    expect(mapSchwabStatus('PARTIALLY_FILLED')).toBe('partial');
    expect(mapSchwabStatus('REJECTED')).toBe('rejected');
    expect(mapSchwabStatus('CANCELED')).toBe('canceled');
    expect(mapSchwabStatus('WORKING')).toBe('accepted');
  });
});

describe('SchwabConnector', () => {
  it('reads buying power from current balances', async () => {
    const { connector } = mock({ '/accounts/H1': { securitiesAccount: { currentBalances: { buyingPower: 10000 } } } });
    expect(await connector.buyingPowerUsd()).toBe(10000);
  });

  it('maps positions (long minus short)', async () => {
    const { connector } = mock({
      '/accounts/H1': { securitiesAccount: { positions: [{ instrument: { symbol: 'MSFT' }, longQuantity: 5, averagePrice: 300, marketValue: 1600 }] } },
    });
    const pos = await connector.positions();
    expect(pos[0]).toMatchObject({ symbol: 'MSFT', qty: 5, avgEntry: 300, marketValue: 1600, currency: 'USD' });
  });

  it('parses a quote keyed by symbol', async () => {
    const { connector } = mock({ '/quotes': { MSFT: { quote: { bidPrice: 299, askPrice: 301, lastPrice: 300 } } } });
    const q = await connector.quote('MSFT');
    expect(q).toMatchObject({ bid: 299, ask: 301, last: 300 });
  });

  it('extracts the new order id from the Location header', async () => {
    const { connector } = mock(
      { '/orders': new Response('', { status: 201, headers: { location: '/trader/v1/accounts/H1/orders/555' } }) },
    );
    const r = await connector.placeOrder({ symbol: 'MSFT', side: 'buy', qty: 1, type: 'market', tif: 'day' });
    expect(r).toMatchObject({ ok: true, orderId: '555', status: 'accepted' });
  });

  it('rejects a limit order without a price', async () => {
    const { connector, calls } = mock({});
    const r = await connector.placeOrder({ symbol: 'MSFT', side: 'buy', qty: 1, type: 'limit', tif: 'day' });
    expect(r.ok).toBe(false);
    expect(calls.length).toBe(0);
  });
});
