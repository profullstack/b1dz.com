/**
 * Fixture built from niche-db docs/crypto.md: Kraken, Coinbase, Binance.US and
 * Gemini rows for a handful of bases, then the grouping and the filters b1dz
 * applied to CoinGecko plus the venue ticker lists.
 */
import { describe, expect, it } from 'vitest';
import { fetchCryptoAssets, fetchCryptoPairs, marketCapsBySymbol, selectCryptoPairs, type CryptoAssetItem, type CryptoPairItem } from './crypto.js';
import { createNichedbClient, type FetchLike } from './client.js';

let nextId = 1;
const RUN = '2026-09-11T06:00:00.000Z';

const VENUE_NAME: Record<string, string> = { kraken: 'Kraken', coinbase: 'Coinbase', 'binance-us': 'Binance.US', gemini: 'Gemini' };

function venueSymbol(venue: string, base: string, quote: string): string {
  switch (venue) {
    case 'kraken': return base === 'BTC' ? `XXBTZ${quote}` : `${base}${quote}`;
    case 'coinbase': return `${base}-${quote}`;
    case 'binance-us': return `${base}${quote}`;
    default: return `${base}${quote}`.toLowerCase();
  }
}

export function pairRow(
  venue: string,
  base: string,
  opts: { quote?: string; price?: number; volume?: number | null; status?: string; change?: number | null } = {},
): CryptoPairItem {
  const quote = opts.quote ?? 'USD';
  const price = opts.price ?? 100;
  const volume = opts.volume === undefined ? (venue === 'gemini' ? null : 1_000_000) : opts.volume;
  const stable = ['USD', 'USDT', 'USDC'].includes(quote);
  const isGemini = venue === 'gemini';
  const isCoinbase = venue === 'coinbase';
  return {
    id: nextId++,
    collection: 'crypto',
    source: 'crypto-pairs',
    kind: 'pair',
    external_id: `pair:${venue}:${base}-${quote}`,
    title: `${base}/${quote} on ${VENUE_NAME[venue]}`,
    published_at: RUN,
    updated_at: RUN,
    tags: ['pair', `venue:${venue}`, `base:${base.toLowerCase()}`, `quote:${quote.toLowerCase()}`, ...(stable ? ['stable-quote'] : [])],
    data: {
      venue,
      venueName: VENUE_NAME[venue],
      base,
      quote,
      venueSymbol: venueSymbol(venue, base, quote),
      status: opts.status ?? 'online',
      price,
      bid: isGemini || isCoinbase ? null : price * 0.999,
      ask: isGemini || isCoinbase ? null : price * 1.001,
      high24h: isGemini ? null : price * 1.05,
      low24h: isGemini ? null : price * 0.95,
      open24h: isGemini ? null : price,
      change24hPct: opts.change === undefined ? 1.2 : opts.change,
      volume24hBase: volume == null ? null : volume / price,
      volume24hQuote: volume,
      vwap24h: isGemini || isCoinbase ? null : price,
      priceUsd: stable ? price : null,
      updatedAt: RUN,
    },
  };
}

export function assetRow(symbol: string, marketCapUsd: number | null, rank: number | null = 1): CryptoAssetItem {
  return {
    id: nextId++,
    collection: 'crypto',
    source: 'coingecko-assets',
    kind: 'asset',
    external_id: `coingecko:${symbol.toLowerCase()}`,
    title: `${symbol} (${symbol})`,
    published_at: RUN,
    updated_at: RUN,
    tags: ['asset', `symbol:${symbol.toLowerCase()}`, ...(rank != null && rank <= 100 ? ['rank:top100'] : [])],
    data: {
      id: symbol.toLowerCase(), symbol: symbol.toLowerCase(), name: symbol, rank, priceUsd: 100, marketCapUsd, fullyDilutedUsd: marketCapUsd,
      volume24hUsd: 1e9, change24hPct: 1, high24h: 105, low24h: 95, supply: { circulating: 1, total: 1, max: null },
      ath: 1, athDate: null, atl: 1, atlDate: null, updatedAt: RUN,
    },
  };
}

const RULES = { minVolumeUsd: 50_000, minMarketCapUsd: 10_000_000, minVenues: 2, excludedBases: ['USDT', 'USDC', 'DAI', 'EUR'] };

/** BTC and ETH everywhere; ONLYK on Kraken alone; THIN under the volume floor on
 *  every venue but one; GEMNULL on Kraken (known) + Gemini (null volume); SMALL
 *  on two venues with a tiny market cap; USDT quoted books to be ignored. */
function fixture() {
  const pairs: CryptoPairItem[] = [
    pairRow('kraken', 'BTC', { price: 60_000, volume: 900_000_000, change: 0.9 }),
    pairRow('coinbase', 'BTC', { price: 60_000, volume: 1_200_000_000, change: -1.3 }),
    pairRow('binance-us', 'BTC', { price: 60_000, volume: 80_000_000, change: -1.4 }),
    pairRow('gemini', 'BTC', { price: 60_000, change: -1.2 }),
    pairRow('kraken', 'BTC', { quote: 'USDT', price: 60_000, volume: 50_000_000 }),
    pairRow('kraken', 'ETH', { price: 3_000, volume: 300_000_000 }),
    pairRow('coinbase', 'ETH', { price: 3_000, volume: 500_000_000 }),
    pairRow('binance-us', 'ETH', { price: 3_000, volume: 30_000_000 }),
    pairRow('gemini', 'ETH', { price: 3_000 }),
    pairRow('kraken', 'ONLYK', { volume: 5_000_000 }),
    pairRow('kraken', 'THIN', { volume: 20_000 }),
    pairRow('coinbase', 'THIN', { volume: 49_999 }),
    pairRow('binance-us', 'THIN', { volume: 400_000 }),
    pairRow('kraken', 'GEMNULL', { volume: 75_000 }),
    pairRow('gemini', 'GEMNULL'),
    pairRow('kraken', 'SMALL', { volume: 100_000 }),
    pairRow('coinbase', 'SMALL', { volume: 100_000 }),
    pairRow('kraken', 'NOCAP', { volume: 100_000 }),
    pairRow('coinbase', 'NOCAP', { volume: 100_000 }),
    pairRow('kraken', 'USDT', { quote: 'USD', volume: 900_000_000 }),
    pairRow('coinbase', 'USDT', { quote: 'USD', volume: 900_000_000 }),
    pairRow('kraken', 'OFFLINE', { volume: 1_000_000, status: 'cancel_only' }),
    pairRow('coinbase', 'OFFLINE', { volume: 1_000_000 }),
    pairRow('kraken', 'BTC', { quote: 'EUR', price: 55_000, volume: 100_000_000 }),
  ];
  const assets: CryptoAssetItem[] = [
    assetRow('BTC', 1.2e12, 1),
    assetRow('ETH', 3.6e11, 2),
    assetRow('USDT', 1.2e11, 3),
    assetRow('SMALL', 4_000_000, 480),
    assetRow('GEMNULL', 50_000_000, 200),
    assetRow('THIN', 90_000_000, 150),
    assetRow('ONLYK', 200_000_000, 90),
    assetRow('OFFLINE', 200_000_000, 91),
    // a second coin sharing ETH's ticker, ranked far lower: must not clobber ETH's cap
    assetRow('eth', 1_000_000, 499),
  ];
  return { pairs, assets };
}

describe('selectCryptoPairs', () => {
  it('groups by base across venues and keeps the venue symbols', () => {
    const { pairs, assets } = fixture();
    const { pairs: out } = selectCryptoPairs(pairs, assets, RULES);
    const btc = out.find((p) => p.pair === 'BTC-USD')!;
    expect(btc).toBeDefined();
    expect(Object.keys(btc.venues).sort()).toEqual(['binance-us', 'coinbase', 'gemini', 'kraken']);
    expect(btc.venues['kraken']!.venueSymbol).toBe('XXBTZUSD');
    expect(btc.venues['coinbase']!.venueSymbol).toBe('BTC-USD');
    expect(btc.venues['binance-us']!.venueSymbol).toBe('BTCUSD');
    expect(btc.venues['gemini']!.venueSymbol).toBe('btcusd');
    expect(btc.marketCapUsd).toBe(1.2e12);
    // Gemini's null volume adds nothing to the total; the USDT and EUR books are not counted.
    expect(btc.totalVolumeUsd).toBe(900_000_000 + 1_200_000_000 + 80_000_000);
    // Coinbase's change wins for the log line, as it did before.
    expect(btc.change24hPct).toBe(-1.3);
  });

  it('applies the two-venue, $50k per venue and $10M market-cap rules', () => {
    const { pairs, assets } = fixture();
    const sel = selectCryptoPairs(pairs, assets, RULES);
    const names = sel.pairs.map((p) => p.pair);
    expect(names).toContain('BTC-USD');
    expect(names).toContain('ETH-USD');
    expect(names).not.toContain('ONLYK-USD'); // one venue
    expect(names).not.toContain('THIN-USD'); // clears $50k on one venue only
    expect(names).not.toContain('SMALL-USD'); // $4M cap
    expect(names).not.toContain('USDT-USD'); // excluded base
    expect(names).not.toContain('OFFLINE-USD'); // cancel_only on Kraken leaves one venue
    expect(names).toContain('NOCAP-USD'); // unknown cap passes, as before
    expect(sel.filteredByVenues).toBe(3); // ONLYK, THIN, OFFLINE
    expect(sel.filteredByMarketCap).toBe(1); // SMALL
    expect(sel.marketCapCount).toBe(8);
  });

  it('treats a null (Gemini) volume as passing, as the old sentinel did', () => {
    const { pairs, assets } = fixture();
    const { pairs: out } = selectCryptoPairs(pairs, assets, RULES);
    const g = out.find((p) => p.pair === 'GEMNULL-USD')!;
    expect(g).toBeDefined();
    expect(Object.keys(g.venues).sort()).toEqual(['gemini', 'kraken']);
    expect(g.venues['gemini']!.volume24hQuote).toBeNull();
    expect(g.totalVolumeUsd).toBe(75_000);
    // Two Gemini-null venues alone would also pass: nothing known says otherwise.
    const twoNull = selectCryptoPairs([pairRow('gemini', 'X'), pairRow('gemini', 'X', { quote: 'USD' })], [], RULES);
    expect(twoNull.pairs).toHaveLength(0); // same venue twice is still one venue
  });

  it('sorts by total known volume descending', () => {
    const { pairs, assets } = fixture();
    const names = selectCryptoPairs(pairs, assets, RULES).pairs.map((p) => p.pair);
    expect(names.slice(0, 2)).toEqual(['BTC-USD', 'ETH-USD']);
  });

  it('honours the MIN_VOLUME_USD style floor and the venue list', () => {
    const { pairs, assets } = fixture();
    const strict = selectCryptoPairs(pairs, assets, { ...RULES, minVolumeUsd: 100_000_000 });
    expect(strict.pairs.map((p) => p.pair)).toEqual(['BTC-USD', 'ETH-USD']);
    // Without Gemini, GEMNULL is a one-venue coin.
    const three = selectCryptoPairs(pairs, assets, { ...RULES, venues: ['kraken', 'coinbase', 'binance-us'] });
    expect(three.pairs.map((p) => p.pair)).not.toContain('GEMNULL-USD');
  });

  it('passes every base through the cap filter when there are no assets at all', () => {
    const { pairs } = fixture();
    const sel = selectCryptoPairs(pairs, [], RULES);
    expect(sel.pairs.map((p) => p.pair)).toContain('SMALL-USD');
    expect(sel.marketCapCount).toBe(0);
  });

  it('keys market caps by upper-cased symbol and lets the better-ranked duplicate win', () => {
    const caps = marketCapsBySymbol([assetRow('eth', 1_000_000, 499), assetRow('ETH', 3.6e11, 2)]);
    expect(caps.get('ETH')).toBe(3.6e11);
  });

  it('ignores rows with a missing or malformed data record', () => {
    const bad = { ...pairRow('kraken', 'BTC'), data: null } as unknown as CryptoPairItem;
    const sel = selectCryptoPairs([bad, pairRow('coinbase', 'BTC')], [], RULES);
    expect(sel.pairs).toHaveLength(0);
  });
});

describe('fetchCryptoPairs / fetchCryptoAssets', () => {
  function serve(rows: { id: number; kind: string; tags: string[] }[]) {
    const urls: URL[] = [];
    const fetch: FetchLike = async (url) => {
      const u = new URL(url);
      urls.push(u);
      const kind = u.searchParams.get('kind');
      const tags = (u.searchParams.get('tags') ?? '').split(',').filter(Boolean);
      const after = Number(u.searchParams.get('after') ?? 0);
      const limit = Number(u.searchParams.get('limit'));
      const page = rows.filter((r) => r.kind === kind && tags.every((t) => r.tags.includes(t)) && r.id > after).slice(0, limit);
      return { ok: true, status: 200, statusText: 'OK', json: async () => ({ count: page.length, items: page }) };
    };
    return { fetch, urls };
  }

  it('reads kind=pair&tags=stable-quote in 200-row pages', async () => {
    const rows = Array.from({ length: 1_400 }, (_, i) => pairRow(['kraken', 'coinbase', 'binance-us', 'gemini'][i % 4]!, `C${i}`));
    const { fetch, urls } = serve(rows);
    const client = createNichedbClient({ baseUrl: 'https://n.test', fetch });
    const out = await fetchCryptoPairs(client);
    expect(out).toHaveLength(1_400);
    expect(urls).toHaveLength(8); // 7 full pages + the short (empty) one
    expect(urls[0]!.searchParams.get('collection')).toBe('crypto');
    expect(urls[0]!.searchParams.get('kind')).toBe('pair');
    expect(urls[0]!.searchParams.get('tags')).toBe('stable-quote');
    expect(urls[0]!.searchParams.get('limit')).toBe('200');
  });

  it('reads kind=asset up to 500 rows (three pages)', async () => {
    const rows = Array.from({ length: 900 }, (_, i) => assetRow(`A${i}`, 1e9, i + 1));
    const { fetch, urls } = serve(rows);
    const client = createNichedbClient({ baseUrl: 'https://n.test', fetch });
    const out = await fetchCryptoAssets(client);
    expect(out).toHaveLength(500);
    expect(urls).toHaveLength(3);
    expect(urls[0]!.searchParams.get('kind')).toBe('asset');
  });
});
