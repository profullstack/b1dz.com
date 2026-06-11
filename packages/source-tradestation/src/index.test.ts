import { describe, it, expect, vi } from 'vitest';
import { TradeStationConnector, mapTradeStationStatus } from './index.js';

function mock(routes: Record<string, unknown>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const key = Object.keys(routes).find((k) => url.includes(k));
    if (!key) return new Response('not found', { status: 404 });
    const body = routes[key];
    return body instanceof Response ? body : new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;
  const connector = new TradeStationConnector({ accessToken: 't', accountId: 'TS1', fetchImpl });
  return { connector, calls };
}

describe('mapTradeStationStatus', () => {
  it('maps TradeStation states', () => {
    expect(mapTradeStationStatus('FLL')).toBe('filled');
    expect(mapTradeStationStatus('FPR')).toBe('partial');
    expect(mapTradeStationStatus('REJ')).toBe('rejected');
    expect(mapTradeStationStatus('CAN')).toBe('canceled');
    expect(mapTradeStationStatus('ACK')).toBe('accepted');
  });
});

describe('TradeStationConnector', () => {
  it('reads buying power', async () => {
    const { connector } = mock({ '/balances': { Balances: [{ BuyingPower: '7500' }] } });
    expect(await connector.buyingPowerUsd()).toBe(7500);
  });

  it('maps positions', async () => {
    const { connector } = mock({ '/positions': { Positions: [{ Symbol: 'TSLA', Quantity: '2', AveragePrice: '250', MarketValue: '520' }] } });
    const pos = await connector.positions();
    expect(pos[0]).toMatchObject({ symbol: 'TSLA', qty: 2, avgEntry: 250, marketValue: 520, currency: 'USD' });
  });

  it('parses a quote', async () => {
    const { connector } = mock({ '/marketdata/quotes': { Quotes: [{ Bid: '249', Ask: '251', Last: '250' }] } });
    expect(await connector.quote('TSLA')).toMatchObject({ bid: 249, ask: 251, last: 250 });
  });

  it('places a limit order with LimitPrice', async () => {
    const { connector, calls } = mock({ '/orderexecution/orders': { Orders: [{ OrderID: 'X1', Message: 'accepted' }] } });
    const r = await connector.placeOrder({ symbol: 'TSLA', side: 'buy', qty: 1, type: 'limit', limitPrice: 200, tif: 'day' });
    expect(r).toMatchObject({ ok: true, orderId: 'X1', status: 'accepted' });
    const body = JSON.parse(calls.at(-1)!.init!.body as string);
    expect(body).toMatchObject({ OrderType: 'Limit', TradeAction: 'BUY', LimitPrice: '200' });
  });

  it('rejects a limit order without a price', async () => {
    const { connector, calls } = mock({});
    const r = await connector.placeOrder({ symbol: 'TSLA', side: 'buy', qty: 1, type: 'limit', tif: 'day' });
    expect(r.ok).toBe(false);
    expect(calls.length).toBe(0);
  });
});
