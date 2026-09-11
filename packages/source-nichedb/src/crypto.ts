/**
 * The `crypto` collection: CoinGecko assets and per-venue spot pairs, per
 * niche-db docs/crypto.md. This module reads the rows and turns them into the
 * per-base venue grouping b1dz's pair discovery filters on.
 */

import type { NichedbClient, NichedbItem } from './client.js';

export type CryptoVenue = 'kraken' | 'coinbase' | 'binance-us' | 'gemini';

/** `data` of a kind=asset row (source coingecko-assets). */
export interface CryptoAssetData {
  id: string;
  symbol: string;
  name: string;
  rank: number | null;
  priceUsd: number | null;
  marketCapUsd: number | null;
  fullyDilutedUsd: number | null;
  volume24hUsd: number | null;
  change24hPct: number | null;
  high24h: number | null;
  low24h: number | null;
  supply: { circulating: number | null; total: number | null; max: number | null };
  ath: number | null;
  athDate: string | null;
  atl: number | null;
  atlDate: string | null;
  updatedAt: string;
}

/** `data` of a kind=pair row (source crypto-pairs). */
export interface CryptoPairData {
  venue: CryptoVenue | string;
  venueName?: string;
  base: string;
  quote: string;
  venueSymbol: string;
  status: string;
  price: number | null;
  bid: number | null;
  ask: number | null;
  high24h: number | null;
  low24h: number | null;
  open24h?: number | null;
  change24hPct: number | null;
  volume24hBase: number | null;
  /** Dollars when the quote is a dollar stable. Null on Gemini (unknown, not zero). */
  volume24hQuote: number | null;
  vwap24h: number | null;
  priceUsd: number | null;
  updatedAt: string;
}

export type CryptoAssetItem = NichedbItem<CryptoAssetData>;
export type CryptoPairItem = NichedbItem<CryptoPairData>;

export const CRYPTO_COLLECTION = 'crypto';

/** Every stable-quoted spot pair across the four venues (about 1,400 rows, 7-8 pages). */
export function fetchCryptoPairs(client: NichedbClient, opts: { since?: string | Date } = {}): Promise<CryptoPairItem[]> {
  return client.walk<CryptoPairData>({
    collection: CRYPTO_COLLECTION,
    kind: 'pair',
    tags: ['stable-quote'],
    since: opts.since,
    limit: 200,
  });
}

/** The top assets by market cap (CoinGecko's two pages of 250; 3 pages of 200 here). */
export function fetchCryptoAssets(client: NichedbClient, opts: { max?: number; since?: string | Date } = {}): Promise<CryptoAssetItem[]> {
  const max = opts.max ?? 500;
  return client.walk<CryptoAssetData>(
    { collection: CRYPTO_COLLECTION, kind: 'asset', since: opts.since, limit: 200 },
    { maxItems: max, maxPages: Math.ceil(max / 200) + 1 },
  );
}

// ─── Grouping and filters ────────────────────────────────────

export interface VenueListing {
  venue: string;
  venueSymbol: string;
  /** Quote-currency 24h volume; null when the venue does not report it (Gemini). */
  volume24hQuote: number | null;
  priceUsd: number | null;
  change24hPct: number | null;
}

/** One tradeable base grouped across venues, in b1dz's canonical `BASE-USD` naming. */
export interface DiscoveredPair {
  /** Canonical b1dz pair, e.g. `BTC-USD`. */
  pair: string;
  base: string;
  quote: string;
  /** Venue slug → that venue's own symbol and ticker. */
  venues: Record<string, VenueListing>;
  /** Sum of the known per-venue volumes (a null volume adds nothing). */
  totalVolumeUsd: number;
  /** 24h change from the first venue that reports one, for logging only. */
  change24hPct: number;
  /** CoinGecko market cap, 0 when the asset is not in the top list. */
  marketCapUsd: number;
}

export interface CryptoSelectionRules {
  /** Per-venue 24h quote-volume floor in dollars. */
  minVolumeUsd: number;
  /** Market-cap floor; a base with an unknown cap passes, as the CoinGecko path did. */
  minMarketCapUsd: number;
  /** A base must clear the volume floor on at least this many venues. */
  minVenues: number;
  /** Bases never traded (stables and fiat). */
  excludedBases?: Iterable<string>;
  /** Quote to keep; b1dz's feeds only know `BASE-USD` books. Default `USD`. */
  quote?: string;
  /** Venues to consider; default the four nichedb carries. */
  venues?: Iterable<string>;
}

export const DEFAULT_CRYPTO_VENUES: readonly CryptoVenue[] = ['kraken', 'coinbase', 'binance-us', 'gemini'];

export interface CryptoSelection {
  pairs: DiscoveredPair[];
  /** Bases dropped for being on fewer than `minVenues` venues (after the volume floor). */
  filteredByVenues: number;
  /** Bases dropped by the market-cap floor. */
  filteredByMarketCap: number;
  /** Assets found for the market-cap lookup. */
  marketCapCount: number;
}

/**
 * Market caps keyed by upper-cased symbol. Two CoinGecko coins can share a
 * ticker; the better-ranked one wins, as it did when CoinGecko's ranked list
 * was walked in order.
 */
export function marketCapsBySymbol(assets: ReadonlyArray<CryptoAssetItem>): Map<string, number> {
  const best = new Map<string, { rank: number; cap: number }>();
  for (const a of assets) {
    const d = a.data;
    if (!d || typeof d.symbol !== 'string') continue;
    const symbol = d.symbol.toUpperCase();
    const rank = typeof d.rank === 'number' && Number.isFinite(d.rank) ? d.rank : Number.POSITIVE_INFINITY;
    const cap = typeof d.marketCapUsd === 'number' && Number.isFinite(d.marketCapUsd) ? d.marketCapUsd : 0;
    const prev = best.get(symbol);
    if (!prev || rank < prev.rank || (rank === prev.rank && cap > prev.cap)) best.set(symbol, { rank, cap });
  }
  return new Map([...best].map(([s, v]) => [s, v.cap]));
}

/**
 * Group pair rows by base across venues and apply b1dz's discovery rules:
 *
 *  1. only online books quoted in `rules.quote` (USD) on a known venue;
 *  2. a venue counts when its `volume24hQuote` is at or above the floor, or
 *     is null: an unknown volume passes, exactly as the old Gemini sentinel
 *     (`minVolumeUsd * 2`) made every Gemini book pass;
 *  3. a base needs `minVenues` counting venues;
 *  4. a base with a known market cap under the floor is dropped; an unknown
 *     cap (not in the top list, or no assets at all) passes.
 *
 * Sorted by total known volume, descending.
 */
export function selectCryptoPairs(
  pairRows: ReadonlyArray<CryptoPairItem>,
  assetRows: ReadonlyArray<CryptoAssetItem>,
  rules: CryptoSelectionRules,
): CryptoSelection {
  const quote = (rules.quote ?? 'USD').toUpperCase();
  const excluded = new Set([...(rules.excludedBases ?? [])].map((b) => b.toUpperCase()));
  const venues = new Set([...(rules.venues ?? DEFAULT_CRYPTO_VENUES)]);
  const marketCaps = marketCapsBySymbol(assetRows);

  const byBase = new Map<string, DiscoveredPair>();
  for (const row of pairRows) {
    const d = row.data;
    if (!d || typeof d.base !== 'string' || typeof d.venue !== 'string') continue;
    if (!venues.has(d.venue)) continue;
    if ((d.quote ?? '').toUpperCase() !== quote) continue;
    if (d.status && d.status !== 'online') continue;
    const base = d.base.toUpperCase();
    if (base.length === 0 || excluded.has(base)) continue;

    const vol = typeof d.volume24hQuote === 'number' && Number.isFinite(d.volume24hQuote) ? d.volume24hQuote : null;
    if (vol !== null && vol < rules.minVolumeUsd) continue;

    const listing: VenueListing = {
      venue: d.venue,
      venueSymbol: d.venueSymbol,
      volume24hQuote: vol,
      priceUsd: typeof d.priceUsd === 'number' ? d.priceUsd : null,
      change24hPct: typeof d.change24hPct === 'number' && Number.isFinite(d.change24hPct) ? d.change24hPct : null,
    };

    let entry = byBase.get(base);
    if (!entry) {
      entry = { pair: `${base}-${quote}`, base, quote, venues: {}, totalVolumeUsd: 0, change24hPct: 0, marketCapUsd: 0 };
      byBase.set(base, entry);
    }
    const prev = entry.venues[d.venue];
    // The same book twice (a stale row plus a fresh one): keep the larger volume.
    if (prev && (prev.volume24hQuote ?? -1) >= (vol ?? -1)) continue;
    if (prev?.volume24hQuote != null) entry.totalVolumeUsd -= prev.volume24hQuote;
    entry.venues[d.venue] = listing;
    if (vol !== null) entry.totalVolumeUsd += vol;
  }

  const pairs: DiscoveredPair[] = [];
  let filteredByVenues = 0;
  let filteredByMarketCap = 0;
  for (const entry of byBase.values()) {
    const listings = Object.values(entry.venues);
    if (listings.length < rules.minVenues) {
      filteredByVenues++;
      continue;
    }
    const cap = marketCaps.get(entry.base) ?? 0;
    entry.marketCapUsd = cap;
    if (marketCaps.size > 0 && cap > 0 && cap < rules.minMarketCapUsd) {
      filteredByMarketCap++;
      continue;
    }
    // Coinbase's reported change first (the old path let Coinbase overwrite), then any venue.
    const change = entry.venues['coinbase']?.change24hPct ?? listings.find((l) => l.change24hPct != null)?.change24hPct ?? 0;
    entry.change24hPct = change;
    pairs.push(entry);
  }
  pairs.sort((a, b) => b.totalVolumeUsd - a.totalVolumeUsd || a.pair.localeCompare(b.pair));

  return { pairs, filteredByVenues, filteredByMarketCap, marketCapCount: marketCaps.size };
}
