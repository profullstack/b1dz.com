import { afterEach, describe, it, expect, vi } from 'vitest';
import { fetchDailySnapshots, parseArgs } from './strategy-backtest.js';

describe('strategy-backtest daily bars via nichedb (NICHEDB_MARKETS)', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const today = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate());

  function historyItem(symbol: string, count = 400) {
    const bars: (string | number | null)[][] = [];
    let ms = today - DAY;
    while (bars.length < count) {
      const dow = new Date(ms).getUTCDay();
      if (dow !== 0 && dow !== 6) bars.unshift([new Date(ms).toISOString().slice(0, 10), 10, 11, 9, 10 + bars.length, 1000, null]);
      ms -= DAY;
    }
    return {
      id: 7, collection: 'markets', kind: 'history', external_id: `history:${symbol}`, title: `${symbol} daily bars`,
      published_at: null, updated_at: new Date().toISOString(), tags: ['history', `symbol:${symbol.toLowerCase()}`, 'feed:iex'],
      data: { symbol, timeframe: '1Day', feed: 'iex', adjustment: 'split', bars, first: bars[0]![0], last: bars[bars.length - 1]![0], count: bars.length },
    };
  }

  function installFetch(nichedbItems: unknown[]) {
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const url = typeof input === 'string' ? input : input.href;
      urls.push(url);
      const host = new URL(url).host;
      if (host === 'nichedb.dev') return Response.json({ count: nichedbItems.length, items: nichedbItems });
      if (host === 'query1.finance.yahoo.com') {
        return Response.json({ chart: { result: [{ timestamp: [1_700_000_000, 1_700_086_400], indicators: { quote: [{ close: [1, 2] }] } }] } });
      }
      return new Response('nope', { status: 404 });
    }));
    return urls;
  }

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('uses Yahoo only when the switch is off', async () => {
    vi.stubEnv('NICHEDB_MARKETS', '');
    const urls = installFetch([historyItem('SPY')]);
    const snaps = await fetchDailySnapshots('SPY', today - 365 * DAY, today);
    expect(urls.some((u) => u.includes('nichedb.dev'))).toBe(false);
    expect(snaps.map((s) => s.exchange)).toEqual(['yahoo', 'yahoo']);
  });

  it('maps nichedb bars to snapshots for an equity and never asks nichedb for crypto', async () => {
    vi.stubEnv('NICHEDB_MARKETS', '1');
    const urls = installFetch([historyItem('SPY')]);
    const snaps = await fetchDailySnapshots('SPY', today - 365 * DAY, today);
    expect(urls).toHaveLength(1);
    expect(new URL(urls[0]!).searchParams.get('tags')).toBe('symbol:spy');
    expect(snaps.length).toBeGreaterThan(240);
    expect(snaps[0]).toMatchObject({ exchange: 'nichedb', pair: 'SPY', assetClass: 'equity', bidSize: 1, askSize: 1 });
    expect(snaps[0]!.bid).toBe(snaps[0]!.ask);
    expect(snaps.every((s, i) => i === 0 || s.ts > snaps[i - 1]!.ts)).toBe(true);
    urls.length = 0;
    const crypto = await fetchDailySnapshots('BTC-USD', today - 365 * DAY, today);
    expect(urls.some((u) => u.includes('nichedb.dev'))).toBe(false);
    expect(crypto.map((s) => s.exchange)).toEqual(['yahoo', 'yahoo']);
  });

  it('falls back to Yahoo when nichedb is missing the symbol or the window is too long', async () => {
    vi.stubEnv('NICHEDB_MARKETS', '1');
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const urls = installFetch([]);
    expect((await fetchDailySnapshots('ZZZZ', today - 90 * DAY, today)).map((s) => s.exchange)).toEqual(['yahoo', 'yahoo']);
    expect(urls.filter((u) => u.includes('nichedb.dev'))).toHaveLength(1);
    urls.length = 0;
    expect((await fetchDailySnapshots('SPY', today - 5 * 365 * DAY, today)).map((s) => s.exchange)).toEqual(['yahoo', 'yahoo']);
    expect(urls.filter((u) => u.includes('nichedb.dev'))).toHaveLength(0);
    stderr.mockRestore();
  });
});

describe('strategy-backtest parseArgs', () => {
  it('defaults to backtesting both asset classes', () => {
    expect(parseArgs(['mean-reversion']).classes).toEqual(['crypto', 'equity']);
  });

  it('restricts to crypto with --crypto', () => {
    expect(parseArgs(['all', '--crypto']).classes).toEqual(['crypto']);
  });

  it('restricts to equities with --equities (or --equity)', () => {
    expect(parseArgs(['all', '--equities']).classes).toEqual(['equity']);
    expect(parseArgs(['all', '--equity']).classes).toEqual(['equity']);
  });

  it('falls back to both when both flags are passed', () => {
    expect(parseArgs(['all', '--crypto', '--equities']).classes).toEqual(['crypto', 'equity']);
  });

  it('reads the strategy selector positionally or via --strategy', () => {
    expect(parseArgs(['breakout']).selector).toBe('breakout');
    expect(parseArgs(['--strategy', 'breakout']).selector).toBe('breakout');
    expect(parseArgs([]).selector).toBeNull();
  });

  it('reads a TSP file path and per-entry amount', () => {
    const a = parseArgs(['--file', 'my.tsp.json', '--amount', '250']);
    expect(a.file).toBe('my.tsp.json');
    expect(a.amount).toBe(250);
  });

  it('defaults amount to 100 and clamps to >= 1', () => {
    expect(parseArgs(['all']).amount).toBe(100);
    expect(parseArgs(['all', '--amount', '0']).amount).toBe(1);
  });
});
