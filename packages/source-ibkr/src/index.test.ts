import { describe, it, expect, vi } from 'vitest';
import { IbkrConnector, mapIbkrStatus } from './index.js';

function mock(routes: Record<string, unknown>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const key = Object.keys(routes).find((k) => url.includes(k));
    if (!key) return new Response('not found', { status: 404 });
    const body = routes[key];
    return body instanceof Response ? body : new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;
  const connector = new IbkrConnector({ baseUrl: 'https://gw/v1/api', accountId: 'U1', fetchImpl });
  return { connector, calls };
}

describe('mapIbkrStatus', () => {
  it('maps IBKR states', () => {
    expect(mapIbkrStatus('Filled')).toBe('filled');
    expect(mapIbkrStatus('PartiallyFilled')).toBe('partial');
    expect(mapIbkrStatus('Rejected')).toBe('rejected');
    expect(mapIbkrStatus('Cancelled')).toBe('canceled');
    expect(mapIbkrStatus('Submitted')).toBe('accepted');
  });
});

describe('IbkrConnector', () => {
  it('advertises international markets and fractional', () => {
    const { connector } = mock({});
    expect(connector.markets).toContain('intl' in {} ? '' : 'uk');
    expect(connector.manifest.capabilities).toContain('market:intl');
    expect(connector.manifest.capabilities).toContain('feature:fractional');
  });

  it('reads buying power from portfolio summary', async () => {
    const { connector } = mock({ '/summary': { buyingpower: { amount: 25000 } } });
    expect(await connector.buyingPowerUsd()).toBe(25000);
  });

  it('maps positions with currency + market value', async () => {
    const { connector } = mock({
      '/positions/0': [{ conid: 8314, ticker: 'IBM', position: 10, avgCost: 120, mktValue: 1300, currency: 'USD' }],
    });
    const pos = await connector.positions();
    expect(pos[0]).toMatchObject({ symbol: 'IBM', qty: 10, avgEntry: 120, marketValue: 1300, currency: 'USD' });
  });

  it('resolves conid then snapshots a quote', async () => {
    const { connector, calls } = mock({
      '/secdef/search': [{ conid: 265598 }],
      '/marketdata/snapshot': [{ '31': 200, '84': 199.9, '86': 200.1 }],
    });
    const q = await connector.quote('AAPL');
    expect(q).toMatchObject({ bid: 199.9, ask: 200.1, last: 200 });
    expect(calls.some((c) => c.url.includes('conids=265598'))).toBe(true);
  });

  it('places a limit order against the resolved conid', async () => {
    const { connector, calls } = mock({
      '/secdef/search': [{ conid: 265598 }],
      '/orders': [{ order_id: 'o99', order_status: 'Submitted' }],
    });
    const r = await connector.placeOrder({ symbol: 'AAPL', side: 'buy', qty: 1, type: 'limit', limitPrice: 150, tif: 'day' });
    expect(r).toMatchObject({ ok: true, orderId: 'o99', status: 'accepted' });
    const body = JSON.parse(calls.at(-1)!.init!.body as string);
    expect(body.orders[0]).toMatchObject({ conid: 265598, orderType: 'LMT', side: 'BUY', price: 150 });
  });

  it('rejects a limit order without a price', async () => {
    const { connector, calls } = mock({});
    const r = await connector.placeOrder({ symbol: 'AAPL', side: 'buy', qty: 1, type: 'limit', tif: 'day' });
    expect(r.ok).toBe(false);
    expect(calls.length).toBe(0);
  });
});
