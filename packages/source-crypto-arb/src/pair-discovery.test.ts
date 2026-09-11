/**
 * Pair discovery behind NICHEDB_CRYPTO: nichedb rows in, the same `BTC-USD`
 * list out; live CoinGecko + venue tickers when the switch is off or nichedb
 * fails. Every request goes through a fake global fetch; nothing is live.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CryptoAssetItem, CryptoPairItem } from '@b1dz/source-nichedb';

const RUN = '2026-09-11T06:00:00.000Z';
let nextId = 1;

function pairRow(venue: string, base: string, volume: number | null, quote = 'USD'): CryptoPairItem {
  const sym = venue === 'coinbase' ? `${base}-${quote}` : venue === 'gemini' ? `${base}${quote}`.toLowerCase() : `${base}${quote}`;
  return {
    id: nextId++, collection: 'crypto', kind: 'pair', external_id: `pair:${venue}:${base}-${quote}`, title: `${base}/${quote}`,
    published_at: RUN, updated_at: RUN, tags: ['pair', `venue:${venue}`, `base:${base.toLowerCase()}`, `quote:${quote.toLowerCase()}`, 'stable-quote'],
    data: {
      venue, base, quote, venueSymbol: sym, status: 'online', price: 100, bid: null, ask: null, high24h: null, low24h: null, change24hPct: 1,
      volume24hBase: volume == null ? null : volume / 100, volume24hQuote: volume, vwap24h: null, priceUsd: 100, updatedAt: RUN,
    },
  };
}

function assetRow(symbol: string, marketCapUsd: number, rank: number): CryptoAssetItem {
  return {
    id: nextId++, collection: 'crypto', kind: 'asset', external_id: `coingecko:${symbol.toLowerCase()}`, title: symbol,
    published_at: RUN, updated_at: RUN, tags: ['asset', `symbol:${symbol.toLowerCase()}`],
    data: {
      id: symbol.toLowerCase(), symbol: symbol.toLowerCase(), name: symbol, rank, priceUsd: 100, marketCapUsd, fullyDilutedUsd: null, volume24hUsd: null,
      change24hPct: null, high24h: null, low24h: null, supply: { circulating: null, total: null, max: null }, ath: null, athDate: null, atl: null, atlDate: null, updatedAt: RUN,
    },
  };
}

const PAIRS: CryptoPairItem[] = [
  pairRow('kraken', 'BTC', 900e6), pairRow('coinbase', 'BTC', 1200e6), pairRow('binance-us', 'BTC', 80e6), pairRow('gemini', 'BTC', null),
  pairRow('kraken', 'ETH', 300e6), pairRow('coinbase', 'ETH', 500e6),
  pairRow('kraken', 'ONLYK', 5e6), // one venue
  pairRow('kraken', 'THIN', 20_000), pairRow('coinbase', 'THIN', 30_000), // under $50k everywhere
  pairRow('kraken', 'GEMNULL', 75_000), pairRow('gemini', 'GEMNULL', null), // Gemini null counts
  pairRow('kraken', 'SMALL', 100_000), pairRow('coinbase', 'SMALL', 100_000), // $4M cap
  pairRow('kraken', 'BTC', 50e6, 'USDT'), // not a USD book
];
const ASSETS: CryptoAssetItem[] = [assetRow('BTC', 1.2e12, 1), assetRow('ETH', 3.6e11, 2), assetRow('SMALL', 4e6, 480), assetRow('GEMNULL', 5e7, 200)];

type Mode = 'ok' | 'fail' | 'empty';

/** Fake fetch for nichedb plus the live fallback hosts. Records every URL. */
function installFetch(mode: Mode) {
  const urls: string[] = [];
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    urls.push(url);
    const u = new URL(url);
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (u.host === 'nichedb.dev') {
      if (mode === 'fail') return json({ error: 'boom' }, 503);
      if (mode === 'empty') return json({ count: 0, items: [] });
      const kind = u.searchParams.get('kind');
      const after = Number(u.searchParams.get('after') ?? 0);
      const rows = (kind === 'pair' ? PAIRS : ASSETS).filter((r) => r.id > after);
      return json({ count: rows.length, items: rows });
    }
    // The live path (ETH and SOL on Kraken + Binance.US; Coinbase needs keys and is skipped).
    // Kraken's XXBTZUSD is left out on purpose: normalizeKrakenBase strips "XX" to "BT", a
    // pre-existing quirk of the live path that this file does not test.
    if (u.host === 'api.kraken.com') {
      return json({ error: [], result: { XETHZUSD: { v: ['0', '100000'], c: ['3000', '0'] }, SOLUSD: { v: ['0', '100000'], c: ['150', '0'] } } });
    }
    if (u.host === 'api.binance.us') {
      return json([
        { symbol: 'ETHUSD', quoteVolume: '30000000', priceChangePercent: '1' },
        { symbol: 'SOLUSD', quoteVolume: '3000000', priceChangePercent: '1' },
      ]);
    }
    if (u.host === 'api.coingecko.com') {
      return json(u.searchParams.get('page') === '1' ? [{ symbol: 'eth', market_cap: 3.6e11 }, { symbol: 'sol', market_cap: 8e10 }] : []);
    }
    return json({ error: 'unexpected host' }, 404);
  });
  vi.stubGlobal('fetch', fetchMock);
  return { urls, nichedb: () => urls.filter((x) => x.includes('nichedb.dev')), live: () => urls.filter((x) => !x.includes('nichedb.dev')) };
}

async function load() {
  vi.resetModules();
  return import('./pair-discovery.js');
}

describe('pair discovery via nichedb', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-11T06:05:00Z'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubEnv('COINBASE_API_KEY_NAME', '');
    vi.stubEnv('MIN_VOLUME_USD', '');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('reads the universe from nichedb only, with the same filters, when NICHEDB_CRYPTO=1', async () => {
    vi.stubEnv('NICHEDB_CRYPTO', '1');
    const f = installFetch('ok');
    const { getActivePairs, discoverPairsFromNichedb } = await load();
    expect(await getActivePairs()).toEqual(['BTC-USD', 'ETH-USD', 'GEMNULL-USD']);
    expect(f.live()).toEqual([]);
    expect(f.nichedb()).toHaveLength(2); // one page of pairs, one page of assets
    const pairUrl = new URL(f.nichedb().find((u) => u.includes('kind=pair'))!);
    expect(pairUrl.searchParams.get('collection')).toBe('crypto');
    expect(pairUrl.searchParams.get('tags')).toBe('stable-quote');
    expect(pairUrl.searchParams.get('limit')).toBe('200');
    expect(f.nichedb().some((u) => u.includes('kind=asset'))).toBe(true);
    // venue symbols travel with each pair for anyone who needs the venue's own name
    const btc = (await discoverPairsFromNichedb()).find((p) => p.pair === 'BTC-USD')!;
    expect(btc.venues['kraken']!.venueSymbol).toBe('BTCUSD');
    expect(btc.venues['gemini']!.volume24hQuote).toBeNull();
    expect(console.error).not.toHaveBeenCalled();
  });

  it('caches the answer for five minutes', async () => {
    vi.stubEnv('NICHEDB_CRYPTO', '1');
    const f = installFetch('ok');
    const { getActivePairs } = await load();
    await getActivePairs();
    await getActivePairs();
    vi.advanceTimersByTime(4 * 60_000);
    await getActivePairs();
    expect(f.nichedb()).toHaveLength(2);
    vi.advanceTimersByTime(61_000);
    await getActivePairs();
    expect(f.nichedb()).toHaveLength(4);
  });

  it('falls back to CoinGecko + venue tickers on a nichedb failure and logs once', async () => {
    vi.stubEnv('NICHEDB_CRYPTO', '1');
    const f = installFetch('fail');
    const { getActivePairs } = await load();
    expect(await getActivePairs()).toEqual(['ETH-USD', 'SOL-USD']);
    expect(f.nichedb().length).toBeGreaterThan(0);
    expect(f.live().some((u) => u.includes('api.kraken.com'))).toBe(true);
    expect(f.live().some((u) => u.includes('api.coingecko.com'))).toBe(true);
    expect(console.error).toHaveBeenCalledTimes(1);
    expect((console.error as unknown as { mock: { calls: string[][] } }).mock.calls[0]![0]).toMatch(/nichedb unavailable .* falling back/);
    vi.advanceTimersByTime(6 * 60_000);
    await getActivePairs();
    expect(console.error).toHaveBeenCalledTimes(1);
  });

  it('falls back on an empty nichedb answer', async () => {
    vi.stubEnv('NICHEDB_CRYPTO', '1');
    const f = installFetch('empty');
    const { getActivePairs } = await load();
    expect(await getActivePairs()).toEqual(['ETH-USD', 'SOL-USD']);
    expect(f.live().some((u) => u.includes('api.kraken.com'))).toBe(true);
    expect(console.error).toHaveBeenCalledTimes(1);
  });

  it('never asks nichedb when the switch is off', async () => {
    vi.stubEnv('NICHEDB_CRYPTO', '');
    const f = installFetch('ok');
    const { getActivePairs } = await load();
    expect(await getActivePairs()).toEqual(['ETH-USD', 'SOL-USD']);
    expect(f.nichedb()).toEqual([]);
    expect(f.live().some((u) => u.includes('api.kraken.com'))).toBe(true);
  });
});
