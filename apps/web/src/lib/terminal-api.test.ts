import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const authenticateMock = vi.fn();
const daemonMock = vi.fn();
let row: { payload_plain: Record<string, unknown> | null } | null = null;
const upserts: Record<string, unknown>[] = [];

vi.mock('@/lib/api-auth', () => ({ authenticate: (...a: unknown[]) => authenticateMock(...a) }));
vi.mock('@/lib/daemon-control', () => ({ daemonEquity: (...a: unknown[]) => daemonMock(...a) }));
vi.mock('@/lib/settings-row', () => ({ loadSettingsRow: async () => row }));

const { getBroker, getWatchlist, postCancel, postConfirm, postOrder, putBroker, putWatchlist, crossSite } = await import('./terminal-api');

const USER = '00000000-0000-4000-8000-0000000000aa';
const client = {
  from: () => ({
    upsert: async (r: Record<string, unknown>) => {
      upserts.push(r);
      row = { payload_plain: r.payload_plain as Record<string, unknown> };
      return { error: null };
    },
  }),
};

function req(path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  return new NextRequest(`https://b1dz.com${path}`, {
    method: init.method ?? 'GET',
    headers: { host: 'b1dz.com', ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}), ...init.headers },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
}

beforeEach(() => {
  authenticateMock.mockReset().mockResolvedValue({ client, userId: USER, email: 'a@b.c' });
  daemonMock.mockReset().mockResolvedValue({ status: 200, body: { ok: true } });
  row = null;
  upserts.length = 0;
});

describe('watchlist', () => {
  it('needs a signed-in user', async () => {
    authenticateMock.mockResolvedValue(null);
    expect((await getWatchlist(req('/api/terminal/watchlist'))).status).toBe(401);
    expect((await putWatchlist(req('/api/terminal/watchlist', { method: 'PUT', body: { symbols: ['AAPL'] } }))).status).toBe(401);
  });

  it('offers the default list until one is saved', async () => {
    const r = await (await getWatchlist(req('/api/terminal/watchlist'))).json();
    expect(r.saved).toBe(false);
    expect(r.symbols).toContain('AAPL');
  });

  it('saves a cleaned list next to the other plain settings and reads it back', async () => {
    row = { payload_plain: { EQUITY_WATCHLIST: 'SPY', V2_MODE: 'observe' } };
    const res = await putWatchlist(req('/api/terminal/watchlist', { method: 'PUT', body: { symbols: ['nvda', 'NVDA', '<x>', 'btc-usd'] } }));
    expect(await res.json()).toEqual({ symbols: ['NVDA', 'BTC-USD'], saved: true });
    expect(upserts[0].payload_plain).toEqual({ EQUITY_WATCHLIST: 'SPY', V2_MODE: 'observe', TERMINAL_WATCHLIST: 'NVDA,BTC-USD' });
    expect(await (await getWatchlist(req('/api/terminal/watchlist'))).json()).toEqual({ symbols: ['NVDA', 'BTC-USD'], saved: true });
  });

  it('keeps a deliberately emptied list empty', async () => {
    await putWatchlist(req('/api/terminal/watchlist', { method: 'PUT', body: { symbols: [] } }));
    expect(await (await getWatchlist(req('/api/terminal/watchlist'))).json()).toEqual({ symbols: [], saved: true });
  });

  it('rejects a body with no symbols', async () => {
    expect((await putWatchlist(req('/api/terminal/watchlist', { method: 'PUT', body: {} }))).status).toBe(400);
  });
});

describe('cross-site guard', () => {
  it('refuses a cookie request from another origin and allows ours and bearer callers', async () => {
    expect(crossSite(req('/x', { method: 'POST', headers: { origin: 'https://evil.example' } }))).toBe(true);
    expect(crossSite(req('/x', { method: 'POST', headers: { origin: 'https://b1dz.com' } }))).toBe(false);
    expect(crossSite(req('/x', { method: 'POST' }))).toBe(false);
    expect(crossSite(req('/x', { method: 'POST', headers: { origin: 'https://evil.example', authorization: 'Bearer abc' } }))).toBe(false);
    const res = await postOrder(req('/api/terminal/orders', { method: 'POST', body: { symbol: 'AAPL', side: 'buy', qty: 1 }, headers: { origin: 'https://evil.example' } }));
    expect(res.status).toBe(403);
    expect(daemonMock).not.toHaveBeenCalled();
  });
});

describe('broker and orders', () => {
  it('relays the account, passing a valid broker id only', async () => {
    daemonMock.mockResolvedValue({ status: 200, body: { broker: 'alpaca', buyingPowerUsd: 100 } });
    const res = await getBroker(req('/api/terminal/broker?broker=Alpaca'));
    expect(await res.json()).toEqual({ broker: 'alpaca', buyingPowerUsd: 100 });
    expect(daemonMock).toHaveBeenCalledWith('account', USER, { broker: 'alpaca' });
    await getBroker(req('/api/terminal/broker?broker=../../etc'));
    expect(daemonMock).toHaveBeenLastCalledWith('account', USER, {});
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('remembers the chosen broker', async () => {
    expect((await putBroker(req('/api/terminal/broker', { method: 'PUT', body: { broker: 'moomoo' } }))).status).toBe(200);
    expect(upserts[0].payload_plain).toEqual({ TERMINAL_BROKER: 'moomoo' });
    expect((await putBroker(req('/api/terminal/broker', { method: 'PUT', body: { broker: 5 } }))).status).toBe(400);
  });

  it('rejects a bad ticket without reaching the daemon', async () => {
    const res = await postOrder(req('/api/terminal/orders', { method: 'POST', body: { symbol: 'AAPL', side: 'buy' } }));
    expect(res.status).toBe(400);
    expect(daemonMock).not.toHaveBeenCalled();
  });

  it('relays only the parsed order fields', async () => {
    daemonMock.mockResolvedValue({ status: 200, body: { result: { ok: true, orderId: '1' } } });
    const res = await postOrder(
      req('/api/terminal/orders', { method: 'POST', body: { symbol: 'aapl', side: 'buy', qty: '3', type: 'limit', limitPrice: 190, broker: 'moomoo', userId: 'someone-else', junk: true } }),
    );
    expect(res.status).toBe(200);
    expect(daemonMock).toHaveBeenCalledWith('order', USER, { symbol: 'AAPL', side: 'buy', type: 'limit', tif: 'day', qty: 3, limitPrice: 190, broker: 'moomoo' });
  });

  it('passes the daemon status through (locked, refused)', async () => {
    daemonMock.mockResolvedValue({ status: 423, body: { locked: true, error: 'Trading is locked.' } });
    expect((await postOrder(req('/api/terminal/orders', { method: 'POST', body: { symbol: 'AAPL', side: 'buy', qty: 1 } }))).status).toBe(423);
    daemonMock.mockResolvedValue({ status: 422, body: { error: 'insufficient buying power' } });
    const res = await postOrder(req('/api/terminal/orders', { method: 'POST', body: { symbol: 'AAPL', side: 'buy', qty: 1 } }));
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe('insufficient buying power');
  });

  it('cancels and confirms by id', async () => {
    expect((await postCancel(req('/api/terminal/orders/cancel', { method: 'POST', body: { orderId: 'abc' } }))).status).toBe(200);
    expect(daemonMock).toHaveBeenLastCalledWith('cancel', USER, { orderId: 'abc' });
    expect((await postCancel(req('/api/terminal/orders/cancel', { method: 'POST', body: {} }))).status).toBe(400);
    expect((await postConfirm(req('/api/terminal/orders/confirm', { method: 'POST', body: { confirmId: 'C1', broker: 'moomoo' } }))).status).toBe(200);
    expect(daemonMock).toHaveBeenLastCalledWith('confirm', USER, { confirmId: 'C1', broker: 'moomoo' });
    expect((await postConfirm(req('/api/terminal/orders/confirm', { method: 'POST', body: {} }))).status).toBe(400);
  });
});
