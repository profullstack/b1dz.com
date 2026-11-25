import { describe, it, expect, vi } from 'vitest';
import {
  MoomooConnector,
  createMoomooConnector,
  fromMoomooCode,
  mapMoomooSimStatus,
  mapMoomooStatus,
  parseMoomooJson,
  sessionFromMarketState,
  toMoomooCode,
} from './index.js';

type Route = unknown | ((init?: RequestInit) => unknown);

/** Routes are matched by "METHOD path-substring", longest key first. */
function mock(routes: Record<string, Route>, cfg: { paper?: boolean; accountId?: string } = {}) {
  const calls: { method: string; url: string; body?: unknown }[] = [];
  const keys = Object.keys(routes).sort((a, b) => b.length - a.length);
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const key = keys.find((k) => {
      const [m, path] = k.split(' ');
      return m === method && url.includes(path);
    });
    if (!key) return new Response('not found', { status: 404 });
    const r = routes[key];
    const body = typeof r === 'function' ? (r as (i?: RequestInit) => unknown)(init) : r;
    if (body instanceof Response) return body.clone();
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;
  const connector = new MoomooConnector({ accessToken: 'tok', fetchImpl, ...cfg });
  return { connector, calls };
}

describe('helpers', () => {
  it('keeps a uint64 account id exact', () => {
    const parsed = parseMoomooJson<{ d: { accounts: { account_id: string }[] } }>('{"s":"ok","d":{"accounts":[{"account_id": 281756476993717634}]}}');
    expect(parsed.d.accounts[0].account_id).toBe('281756476993717634');
  });

  it('converts symbols both ways', () => {
    expect(toMoomooCode('aapl')).toBe('US.AAPL');
    expect(toMoomooCode('US.AAPL')).toBe('US.AAPL');
    expect(fromMoomooCode('US.BRK.B')).toBe('BRK.B');
    expect(fromMoomooCode('AAPL')).toBe('AAPL');
  });

  it('maps live and paper order states', () => {
    expect(mapMoomooStatus('FILLED_ALL')).toEqual({ status: 'filled', open: false });
    expect(mapMoomooStatus('FILLED_PART')).toEqual({ status: 'partial', open: true });
    expect(mapMoomooStatus('SUBMITTED')).toEqual({ status: 'accepted', open: true });
    expect(mapMoomooStatus('CANCELLED_ALL').status).toBe('canceled');
    expect(mapMoomooStatus('FAILED').status).toBe('rejected');
    expect(mapMoomooSimStatus(2)).toEqual({ status: 'accepted', open: true });
    expect(mapMoomooSimStatus(4).status).toBe('filled');
    expect(mapMoomooSimStatus(7).status).toBe('canceled');
    expect(mapMoomooSimStatus(6).status).toBe('rejected');
  });

  it('maps market states to sessions', () => {
    expect(sessionFromMarketState('AFTERNOON')).toBe('open');
    expect(sessionFromMarketState('PRE_MARKET_BEGIN')).toBe('pre');
    expect(sessionFromMarketState('AFTER_HOURS_BEGIN')).toBe('post');
    expect(sessionFromMarketState('AFTER_HOURS_END')).toBe('closed');
    expect(sessionFromMarketState(undefined)).toBe('closed');
  });
});

describe('MoomooConnector (paper)', () => {
  const accounts = { ret_code: 0, ret_msg: 'success', data: { accounts: [{ account_id: '111', market_id: 1 }, { account_id: '80306537', market_id: 100 }] } };

  it('defaults to paper and requires a token', () => {
    const c = createMoomooConnector({ accessToken: 't' });
    expect(c.isPaper).toBe(true);
    expect(c.manifest.capabilities).toContain('feature:paper');
    expect(() => createMoomooConnector({ accessToken: '' })).toThrow();
  });

  it('finds the US paper account and reads buying power', async () => {
    const { connector, calls } = mock({
      'GET /sim-trade/accounts': accounts,
      'GET /sim-trade/80306537/cash-info': { ret_code: 0, data: { max_power_long: '199000.50', balance: '100000' } },
    });
    expect(await connector.buyingPowerUsd()).toBe(199000.5);
    await connector.buyingPowerUsd();
    expect(calls.filter((c) => c.url.endsWith('/sim-trade/accounts'))).toHaveLength(1); // discovered once
  });

  it('places a paper limit order as whole shares', async () => {
    const { connector, calls } = mock({
      'GET /sim-trade/accounts': accounts,
      'POST /sim-trade/80306537/orders': { ret_code: 0, data: { order_id: 'S1' } },
    });
    const r = await connector.placeOrder({ symbol: 'aapl', side: 'buy', qty: 3, type: 'limit', limitPrice: 150.25, tif: 'day', extendedHours: true });
    expect(r).toMatchObject({ ok: true, orderId: 'S1', status: 'accepted' });
    expect(calls.at(-1)?.body).toEqual({ market: 100, symbol: 'US.AAPL', order_type: 1, order_side: 1, qty: '3', price: '150.25', order_trade_time_type: 2 });
  });

  it('turns a notional into whole shares and refuses less than one', async () => {
    const { connector, calls } = mock({
      'GET /sim-trade/accounts': accounts,
      'POST /quote/snapshot': { ret_code: 0, data: { snapshot_list: [{ code: 'US.AAPL', last_price: 200, bid_price: 199.9, ask_price: 200.1 }] } },
      'POST /sim-trade/80306537/orders': { ret_code: 0, data: { order_id: 'S2' } },
    });
    expect((await connector.placeOrder({ symbol: 'AAPL', side: 'buy', notionalUsd: 650, type: 'market', tif: 'day' })).ok).toBe(true);
    expect(calls.at(-1)?.body).toMatchObject({ qty: '3', order_type: 3 });
    const small = await connector.placeOrder({ symbol: 'AAPL', side: 'buy', notionalUsd: 50, type: 'market', tif: 'day' });
    expect(small.ok).toBe(false);
    expect(small.message).toMatch(/whole shares/);
    expect((await connector.placeOrder({ symbol: 'AAPL', side: 'buy', qty: 0.5, type: 'market', tif: 'day' })).ok).toBe(false);
  });

  it('reports a business error that rides on HTTP 200', async () => {
    const { connector } = mock({
      'GET /sim-trade/accounts': accounts,
      'POST /sim-trade/80306537/orders': { ret_code: -5, ret_msg: 'backend_biz_error', error: { code: 'backend_biz_error', message: 'insufficient buying power' } },
    });
    const r = await connector.placeOrder({ symbol: 'AAPL', side: 'buy', qty: 1, type: 'market', tif: 'day' });
    expect(r).toMatchObject({ ok: false, status: 'rejected', message: 'insufficient buying power' });
  });

  it('lists paper positions and orders, and cancels with the market id', async () => {
    const { connector, calls } = mock(
      {
        'GET /sim-trade/9/positions': {
          ret_code: 0,
          data: {
            positions: [
              { symbol: 'AAPL', qty: '10', cost_price: '150', mv: '2000', pstn_type: 0 },
              { symbol: 'TSLA', qty: '2', cost_price: '300', mv: '500', pstn_type: 1 },
            ],
          },
        },
        'GET /sim-trade/9/orders': {
          ret_code: 0,
          data: {
            orders: [
              { order_id: 'A', symbol: 'AAPL', side: 1, order_type: 1, status: 2, qty: '5', cum_qty: '0', price: '149.5', create_time: '1700000000000000' },
              { order_id: 'B', symbol: 'MSFT', side: 2, order_type: 3, status: 4, qty: '1', cum_qty: '1', avg_fill_price: '410.2', create_time: '1700000100000000' },
            ],
          },
        },
        'POST /sim-trade/9/orders/A/cancel': { ret_code: 0, data: { order_id: 'A' } },
      },
      { accountId: '9' },
    );
    expect(await connector.positions()).toEqual([
      { symbol: 'AAPL', qty: 10, avgEntry: 150, marketValue: 2000, currency: 'USD' },
      { symbol: 'TSLA', qty: -2, avgEntry: 300, marketValue: 500, currency: 'USD' },
    ]);
    const orders = await connector.listOrders();
    expect(orders.map((o) => o.orderId)).toEqual(['B', 'A']); // newest first
    expect(orders[1]).toMatchObject({ symbol: 'AAPL', side: 'buy', type: 'limit', qty: 5, limitPrice: 149.5, open: true, status: 'accepted' });
    expect(orders[0]).toMatchObject({ side: 'sell', type: 'market', fillPrice: 410.2, open: false, status: 'filled' });
    expect((await connector.cancelOrder('A')).ok).toBe(true);
    expect(calls.at(-1)?.body).toEqual({ market: 100 });
  });
});

describe('MoomooConnector (live)', () => {
  const accs =
    '{"s":"ok","d":{"accounts":[{"account_id": 281756476993717634,"enable_market":[1]},{"account_id": 281756476993717999,"enable_market":[2],"acc_type":"margin"}]}}';

  it('picks the US account without losing id digits', async () => {
    const { connector, calls } = mock(
      {
        'GET /accounts/authorized_trd_accs': accs,
        'GET /funds': { s: 'ok', d: { power: '12748.52964000', cash: '242451.68' } },
      },
      { paper: false },
    );
    expect(await connector.buyingPowerUsd()).toBeCloseTo(12748.52964);
    expect(calls.at(-1)?.url).toContain('/accounts/281756476993717999/funds?currency=USD');
    expect(connector.manifest.capabilities).not.toContain('feature:paper');
  });

  it('places a live limit order and sends the bearer token', async () => {
    let auth = '';
    const { connector, calls } = mock(
      {
        'POST /accounts/77/orders': (init?: RequestInit) => {
          auth = (init?.headers as Record<string, string>).Authorization;
          return { s: 'ok', d: { order_id: 'FH1' } };
        },
      },
      { paper: false, accountId: '77' },
    );
    const r = await connector.placeOrder({ symbol: 'AAPL', side: 'sell', qty: 100, type: 'limit', limitPrice: 150, tif: 'gtc', extendedHours: true });
    expect(r).toMatchObject({ ok: true, orderId: 'FH1', status: 'accepted' });
    expect(auth).toBe('Bearer tok');
    expect(calls.at(-1)?.body).toEqual({
      code: 'US.AAPL',
      qty: '100',
      price: '150',
      side: 'SELL',
      order_type: 'LIMIT',
      time_in_force: 'GTC',
      session: 'RTH+Pre/Post-Mkt',
      remark: 'b1dz',
    });
  });

  it('never asks for extended hours on a market order', async () => {
    const { connector, calls } = mock({ 'POST /accounts/77/orders': { s: 'ok', d: { order_id: 'FH2' } } }, { paper: false, accountId: '77' });
    await connector.placeOrder({ symbol: 'AAPL', side: 'buy', qty: 1, type: 'market', tif: 'day', extendedHours: true });
    expect(calls.at(-1)?.body).toEqual({ code: 'US.AAPL', qty: '1', side: 'BUY', order_type: 'MARKET', time_in_force: 'DAY', remark: 'b1dz' });
  });

  it('surfaces a confirmation request, then confirms it', async () => {
    const { connector, calls } = mock(
      {
        'POST /accounts/77/orders': { s: 'error', errcode: 108330261, errmsg: 'Price is far from the market.', need_order_confirm: true, confirm_id: 'C9' },
        'POST /accounts/77/order_confirm': { s: 'ok', d: { order_id: 'FH3' } },
      },
      { paper: false, accountId: '77' },
    );
    const r = await connector.placeOrder({ symbol: 'AAPL', side: 'buy', qty: 1, type: 'limit', limitPrice: 1, tif: 'day' });
    expect(r.ok).toBe(false);
    expect(r.needsConfirm).toEqual({ id: 'C9', url: undefined });
    expect(r.message).toBe('Price is far from the market.');
    expect(await connector.confirmOrder('C9')).toMatchObject({ ok: true, orderId: 'FH3' });
    expect(calls.at(-1)?.body).toEqual({ confirm_id: 'C9' });
  });

  it('reports a plain rejection', async () => {
    const { connector } = mock(
      { 'POST /accounts/77/orders': { s: 'error', errcode: 344, errmsg: 'Trading for this market not activated.', need_order_confirm: false } },
      { paper: false, accountId: '77' },
    );
    expect(await connector.placeOrder({ symbol: 'AAPL', side: 'buy', qty: 1, type: 'market', tif: 'day' })).toMatchObject({
      ok: false,
      status: 'rejected',
      message: 'Trading for this market not activated.',
    });
  });

  it('explains an expired token', async () => {
    const { connector } = mock(
      { 'GET /accounts/77/positions': new Response(JSON.stringify({ code: -12102, trace_id: 'x' }), { status: 401 }) },
      { paper: false, accountId: '77' },
    );
    await expect(connector.positions()).rejects.toThrow(/reconnect moomoo/);
  });

  it('keeps US positions only and signs shorts', async () => {
    const { connector } = mock(
      {
        'GET /accounts/77/positions': {
          s: 'ok',
          d: [
            { code: 'HK.00700', qty: '2100', cost_price: '443', market_val: '813960', currency: 'HKD', position_side: 'LONG' },
            { code: 'US.NVDA', qty: '4', cost_price: '120.5', market_val: '520', currency: 'USD', position_side: 'SHORT' },
          ],
        },
      },
      { paper: false, accountId: '77' },
    );
    expect(await connector.positions()).toEqual([{ symbol: 'NVDA', qty: -4, avgEntry: 120.5, marketValue: 520, currency: 'USD' }]);
  });

  it('cancels with the exchange the order carries', async () => {
    const { connector, calls } = mock(
      {
        'GET /accounts/77/orders': {
          s: 'ok',
          d: { orders: [{ order_id: 'O1', code: 'US.AAPL', exchange: 'NASDAQ', side: 'BUY', order_type: 'LIMIT', order_status: 'SUBMITTED', qty: '5', price: '100', create_time: 1700000000000000 }] },
        },
        'DELETE /accounts/77/orders/O1': { s: 'ok' },
      },
      { paper: false, accountId: '77' },
    );
    expect((await connector.cancelOrder('O1')).ok).toBe(true);
    expect(calls.at(-1)?.url).toContain('/accounts/77/orders/O1?exchange=NASDAQ');
    const missing = await connector.cancelOrder('NOPE');
    expect(missing.ok).toBe(false);
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(1);
  });

  it('quotes from the snapshot and reads the session', async () => {
    const { connector } = mock(
      {
        'POST /quote/snapshot': { ret_code: 0, ret_msg: '', data: { snapshot_list: [{ code: 'US.AAPL', last_price: 190.1, bid_price: 190, ask_price: 190.2, update_time: 1700000000000 }] } },
        'POST /quote/market-state': { ret_code: 0, data: { market_state_list: [{ code: 'US.AAPL', market_state: 'PRE_MARKET_BEGIN' }] } },
      },
      { paper: false, accountId: '77' },
    );
    expect(await connector.quote('AAPL')).toEqual({ bid: 190, ask: 190.2, last: 190.1, ts: 1700000000000 });
    expect((await connector.session('AAPL')).status).toBe('pre');
  });
});
