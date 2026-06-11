import { describe, it, expect, vi } from 'vitest';
import { WebullConnector, mapWebullStatus } from './index.js';

function mock(routes: Record<string, unknown>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const key = Object.keys(routes).find((k) => url.includes(k));
    if (!key) return new Response('not found', { status: 404 });
    const body = routes[key];
    return body instanceof Response ? body : new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;
  const connector = new WebullConnector({ accessToken: 't', accountId: 'WB1', fetchImpl });
  return { connector, calls };
}

describe('mapWebullStatus', () => {
  it('maps Webull states', () => {
    expect(mapWebullStatus('FILLED')).toBe('filled');
    expect(mapWebullStatus('PARTIAL_FILLED')).toBe('partial');
    expect(mapWebullStatus('FAILED')).toBe('rejected');
    expect(mapWebullStatus('CANCELLED')).toBe('canceled');
    expect(mapWebullStatus('SUBMITTED')).toBe('accepted');
  });
});

describe('WebullConnector', () => {
  it('reads buying power', async () => {
    const { connector } = mock({ '/account/balance': { buyingPower: 3000 } });
    expect(await connector.buyingPowerUsd()).toBe(3000);
  });

  it('maps positions', async () => {
    const { connector } = mock({ '/account/positions': { positions: [{ symbol: 'NVDA', quantity: 3, costPrice: 100, marketValue: 330 }] } });
    const pos = await connector.positions();
    expect(pos[0]).toMatchObject({ symbol: 'NVDA', qty: 3, avgEntry: 100, marketValue: 330, currency: 'USD' });
  });

  it('parses a quote', async () => {
    const { connector } = mock({ '/market/quote': { bid: 109, ask: 111, last: 110 } });
    expect(await connector.quote('NVDA')).toMatchObject({ bid: 109, ask: 111, last: 110 });
  });

  it('places an order and maps the status', async () => {
    const { connector } = mock({ '/trade/order': { orderId: 'WO1', status: 'SUBMITTED' } });
    const r = await connector.placeOrder({ symbol: 'NVDA', side: 'buy', qty: 1, type: 'market', tif: 'day' });
    expect(r).toMatchObject({ ok: true, orderId: 'WO1', status: 'accepted' });
  });

  it('rejects a limit order without a price', async () => {
    const { connector, calls } = mock({});
    const r = await connector.placeOrder({ symbol: 'NVDA', side: 'buy', qty: 1, type: 'limit', tif: 'day' });
    expect(r.ok).toBe(false);
    expect(calls.length).toBe(0);
  });
});
