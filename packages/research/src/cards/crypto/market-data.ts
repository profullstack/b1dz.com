/**
 * Market-wide coin data. CoinPaprika answers first (its keyless plan allows
 * 20,000 requests a month); CoinGecko's public API is the fallback and is
 * the only source for trending, categories, treasuries and derivatives
 * exchanges. CoinGecko allows roughly five requests a minute from a server
 * address, so everything from it is cached for a long time.
 */
import { firstOf } from '../../http.js';
import { SourceError, type Ctx } from '../../types.js';
import { list, n, rec, str } from './util.js';

export const PAPRIKA = 'CoinPaprika';
export const GECKO = 'CoinGecko';
const PAPRIKA_BASE = 'https://api.coinpaprika.com/v1';
const GECKO_BASE = 'https://api.coingecko.com/api/v3';

export interface MarketCoin {
  /** Provider id: "btc-bitcoin" on CoinPaprika, "bitcoin" on CoinGecko. */
  id: string;
  symbol: string;
  name: string;
  rank: number;
  price: number;
  marketCap: number | null;
  volume24h: number | null;
  chg1h: number | null;
  chg24h: number | null;
  chg7d: number | null;
  chg30d: number | null;
  chg1y: number | null;
  athPrice: number | null;
  /** ISO date of the all-time high. */
  athDate: string | null;
  fromAth: number | null;
  /** Coins in existence as the provider counts them. */
  supply: number | null;
  /** null when the coin has no cap. */
  maxSupply: number | null;
}

/** CoinPaprika `GET /tickers` to coins, in rank order. */
export function parsePaprikaTickers(body: unknown): MarketCoin[] {
  const out: MarketCoin[] = [];
  for (const raw of list(body)) {
    const c = rec(raw);
    const q = rec(rec(c.quotes).USD);
    const price = n(q.price);
    const rank = n(c.rank);
    if (!str(c.id) || price === null || !(price > 0) || rank === null || rank <= 0) continue;
    const max = n(c.max_supply);
    out.push({
      id: str(c.id),
      symbol: str(c.symbol).toUpperCase(),
      name: str(c.name),
      rank,
      price,
      marketCap: n(q.market_cap),
      volume24h: n(q.volume_24h),
      chg1h: n(q.percent_change_1h),
      chg24h: n(q.percent_change_24h),
      chg7d: n(q.percent_change_7d),
      chg30d: n(q.percent_change_30d),
      chg1y: n(q.percent_change_1y),
      athPrice: n(q.ath_price),
      athDate: str(q.ath_date).slice(0, 10) || null,
      fromAth: n(q.percent_from_price_ath),
      supply: n(c.total_supply),
      maxSupply: max !== null && max > 0 ? max : null,
    });
  }
  return out.sort((a, b) => a.rank - b.rank);
}

/** CoinGecko `GET /coins/markets` to coins, in rank order. */
export function parseGeckoMarkets(body: unknown): MarketCoin[] {
  const out: MarketCoin[] = [];
  for (const raw of list(body)) {
    const c = rec(raw);
    const price = n(c.current_price);
    const rank = n(c.market_cap_rank);
    if (!str(c.id) || price === null || !(price > 0) || rank === null) continue;
    out.push({
      id: str(c.id),
      symbol: str(c.symbol).toUpperCase(),
      name: str(c.name),
      rank,
      price,
      marketCap: n(c.market_cap),
      volume24h: n(c.total_volume),
      chg1h: n(c.price_change_percentage_1h_in_currency),
      chg24h: n(c.price_change_percentage_24h_in_currency) ?? n(c.price_change_percentage_24h),
      chg7d: n(c.price_change_percentage_7d_in_currency),
      chg30d: n(c.price_change_percentage_30d_in_currency),
      chg1y: null,
      athPrice: n(c.ath),
      athDate: str(c.ath_date).slice(0, 10) || null,
      fromAth: n(c.ath_change_percentage),
      supply: n(c.circulating_supply),
      maxSupply: n(c.max_supply),
    });
  }
  return out.sort((a, b) => a.rank - b.rank);
}

export async function paprika<T>(ctx: Ctx, path: string, ttl = 300): Promise<T> {
  const body = await ctx.http.json<T>(`${PAPRIKA_BASE}${path}`, { source: PAPRIKA, ttl });
  const err = rec(body).error;
  if (typeof err === 'string') throw new SourceError(PAPRIKA, err);
  return body;
}

/** CoinGecko, cached for at least ten minutes: the public API allows about five requests a minute. */
export async function gecko<T>(ctx: Ctx, path: string, ttl = 1800): Promise<T> {
  return ctx.http.json<T>(`${GECKO_BASE}${path}`, { source: GECKO, ttl: Math.max(ttl, 600) });
}

export interface Market {
  coins: MarketCoin[];
  source: string;
  skipped: string[];
}

/** The top 500 coins by market value (250 when CoinGecko has to answer). */
export async function loadMarket(ctx: Ctx): Promise<Market> {
  const got = await firstOf([
    {
      name: PAPRIKA,
      run: async () => {
        const coins = parsePaprikaTickers(await paprika<unknown>(ctx, '/tickers?limit=500', 300));
        if (coins.length < 10) throw new SourceError(PAPRIKA, 'the ticker list came back empty');
        return coins;
      },
    },
    {
      name: GECKO,
      run: async () => {
        const coins = parseGeckoMarkets(
          await gecko<unknown>(ctx, '/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=1&price_change_percentage=1h,24h,7d,30d', 900),
        );
        if (coins.length < 10) throw new SourceError(GECKO, 'the market list came back empty');
        return coins;
      },
    },
  ]);
  return { coins: got.value, source: got.source, skipped: got.skipped };
}

/** Tokens that share a ticker with a bigger coin are ranked lower, so the best rank wins. */
export function findCoin(coins: MarketCoin[], query: string): MarketCoin | undefined {
  const q = query.trim().toLowerCase();
  if (!q) return undefined;
  return coins.find((c) => c.symbol.toLowerCase() === q) ?? coins.find((c) => c.name.toLowerCase() === q) ?? coins.find((c) => c.id === q);
}

/** The CoinPaprika id for a symbol or name: from the cached ticker list, else CoinPaprika search. */
export async function paprikaId(ctx: Ctx, query: string): Promise<{ id: string; coin?: MarketCoin }> {
  try {
    const coins = parsePaprikaTickers(await paprika<unknown>(ctx, '/tickers?limit=500', 300));
    const hit = findCoin(coins, query);
    if (hit) return { id: hit.id, coin: hit };
  } catch {
    // fall through to search
  }
  const found = await paprika<unknown>(ctx, `/search?q=${encodeURIComponent(query)}&c=currencies&limit=5`, 3600);
  const first = rec(list(rec(found).currencies)[0]);
  if (!str(first.id)) throw new SourceError(PAPRIKA, `no coin matches "${query}"`);
  return { id: str(first.id) };
}

export const STABLE_SYMBOLS = new Set(['USDT', 'USDC', 'DAI', 'USDS', 'USDE', 'FDUSD', 'PYUSD', 'USD1', 'TUSD', 'USDD', 'BUSD', 'RLUSD', 'USDG', 'FRAX', 'USDP', 'GUSD', 'USDTB', 'BFUSD', 'USDF', 'USD0', 'SUSDE', 'SUSDS', 'BUIDL']);
