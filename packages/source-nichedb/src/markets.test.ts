import { describe, expect, it } from 'vitest';
import { createNichedbClient, type FetchLike } from './client.js';
import { barsFromHistory, dayToUtcMs, fetchDailyBars, historySymbolTag, historyWindow, DAY_MS, type HistoryItem } from './markets.js';

const NOW = Date.UTC(2026, 8, 16, 14, 0, 0); // 2026-09-16 14:00Z, a Wednesday

function ymd(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** `count` weekday bars ending on `lastDay`, oldest first, close = 100 + i. */
export function historyItem(symbol: string, lastMs: number, count: number): HistoryItem {
  const bars: HistoryItem['data']['bars'] = [];
  let ms = lastMs;
  while (bars.length < count) {
    const dow = new Date(ms).getUTCDay();
    if (dow !== 0 && dow !== 6) bars.unshift([ymd(ms), 100, 101, 99, 100 + bars.length, 1_000, 100.5]);
    ms -= DAY_MS;
  }
  // close values were assigned newest-first above; make them ascend oldest-first for readable tests
  bars.forEach((b, i) => { b[4] = 100 + i; });
  return {
    id: 1,
    collection: 'markets',
    source: 'equity-history',
    kind: 'history',
    external_id: `history:${symbol}`,
    title: `${symbol} daily bars`,
    published_at: `${bars[bars.length - 1]![0]}T00:00:00.000Z`,
    updated_at: '2026-09-11T00:30:00.000Z',
    tags: ['history', `symbol:${symbol.toLowerCase()}`, 'feed:iex'],
    data: { symbol, timeframe: '1Day', feed: 'iex', adjustment: 'split', bars, first: bars[0]![0], last: bars[bars.length - 1]![0], count: bars.length },
  };
}

describe('history mapping', () => {
  it('tags symbols lower-case in Alpaca spelling', () => {
    expect(historySymbolTag('AAPL')).toBe('symbol:aapl');
    expect(historySymbolTag('BRK-B')).toBe('symbol:brk.b');
  });

  it('maps YYYY-MM-DD to midnight UTC', () => {
    expect(dayToUtcMs('2026-09-10')).toBe(Date.UTC(2026, 8, 10));
    expect(dayToUtcMs('nope')).toBeNull();
  });

  it('maps bar tuples to OHLCV rows, oldest first, dropping malformed ones', () => {
    const item = historyItem('AAPL', NOW - DAY_MS, 3);
    item.data.bars.push(['bad', 1, 1, 1, 1, 1, null], ['2026-09-12', Number.NaN, 1, 1, 1, 1, null]);
    const bars = barsFromHistory(item.data);
    expect(bars).toHaveLength(3);
    expect(bars[0]!.ts).toBeLessThan(bars[2]!.ts);
    expect(bars[0]).toMatchObject({ open: 100, high: 101, low: 99, close: 100, volume: 1_000, vwap: 100.5 });
    expect(bars[0]!.ts).toBe(dayToUtcMs(bars[0]!.day));
  });
});

describe('historyWindow', () => {
  const start = NOW - 365 * DAY_MS;

  it('serves a one-year request from a fresh 400-bar window, padded a week either side', () => {
    const item = historyItem('AAPL', NOW - DAY_MS, 400);
    const r = historyWindow(item, start, NOW, { now: NOW });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.bars[0]!.ts).toBeGreaterThanOrEqual(start - 7 * DAY_MS);
    expect(r.bars[0]!.ts).toBeLessThanOrEqual(start);
    expect(r.bars[r.bars.length - 1]!.day).toBe(ymd(NOW - DAY_MS));
    expect(r.bars.length).toBeGreaterThan(250);
  });

  it('falls back when the item is missing', () => {
    expect(historyWindow(null, start, NOW, { now: NOW })).toEqual({ ok: false, reason: 'missing' });
  });

  it('falls back when the last bar is older than 5 days', () => {
    // Wednesday now: a bar from last Friday (5 days) still serves; last Thursday (6 days) does not.
    const fresh = historyItem('AAPL', NOW - 5 * DAY_MS, 400);
    expect(fresh.data.last).toBe('2026-09-11');
    expect(historyWindow(fresh, start, NOW, { now: NOW }).ok).toBe(true);
    const stale = historyItem('AAPL', NOW - 6 * DAY_MS, 400);
    expect(stale.data.last).toBe('2026-09-10');
    expect(historyWindow(stale, start, NOW, { now: NOW })).toMatchObject({ ok: false, reason: 'stale' });
  });

  it('falls back when the request spans more than 400 days', () => {
    const item = historyItem('AAPL', NOW - DAY_MS, 400);
    expect(historyWindow(item, NOW - 401 * DAY_MS, NOW, { now: NOW })).toEqual({ ok: false, reason: 'window-too-long' });
    expect(historyWindow(item, NOW - 400 * DAY_MS, NOW, { now: NOW }).ok).toBe(true);
  });

  it('falls back when the window does not reach the requested start', () => {
    const young = historyItem('NEWCO', NOW - DAY_MS, 40);
    expect(historyWindow(young, start, NOW, { now: NOW })).toMatchObject({ ok: false, reason: 'short' });
    expect(historyWindow(young, NOW - 30 * DAY_MS, NOW, { now: NOW }).ok).toBe(true);
  });

  it('falls back on an item with no usable bars', () => {
    const item = historyItem('AAPL', NOW - DAY_MS, 1);
    item.data.bars = [];
    expect(historyWindow(item, start, NOW, { now: NOW })).toMatchObject({ ok: false, reason: 'empty' });
  });
});

describe('fetchDailyBars', () => {
  function serve(items: HistoryItem[]) {
    const urls: URL[] = [];
    const fetch: FetchLike = async (url) => {
      const u = new URL(url);
      urls.push(u);
      const tags = (u.searchParams.get('tags') ?? '').split(',');
      const hit = items.filter((i) => tags.every((t) => i.tags.includes(t))).slice(0, Number(u.searchParams.get('limit')));
      return { ok: true, status: 200, statusText: 'OK', json: async () => ({ count: hit.length, items: hit }) };
    };
    return { fetch, urls };
  }

  it('asks for collection=markets&kind=history&tags=symbol:<sym>&limit=1', async () => {
    const { fetch, urls } = serve([historyItem('AAPL', NOW - DAY_MS, 400)]);
    const client = createNichedbClient({ baseUrl: 'https://n.test', fetch });
    const r = await fetchDailyBars(client, 'AAPL', NOW - 365 * DAY_MS, NOW, { now: NOW });
    expect(r.ok).toBe(true);
    expect(urls).toHaveLength(1);
    const q = urls[0]!.searchParams;
    expect(q.get('collection')).toBe('markets');
    expect(q.get('kind')).toBe('history');
    expect(q.get('tags')).toBe('symbol:aapl');
    expect(q.get('limit')).toBe('1');
  });

  it('reports missing for an unknown symbol and makes no request for an over-long window', async () => {
    const { fetch, urls } = serve([]);
    const client = createNichedbClient({ baseUrl: 'https://n.test', fetch });
    expect(await fetchDailyBars(client, 'ZZZZ', NOW - 30 * DAY_MS, NOW, { now: NOW })).toEqual({ ok: false, reason: 'missing' });
    expect(urls).toHaveLength(1);
    expect(await fetchDailyBars(client, 'AAPL', NOW - 5 * 365 * DAY_MS, NOW, { now: NOW })).toEqual({ ok: false, reason: 'window-too-long' });
    expect(urls).toHaveLength(1);
  });
});
