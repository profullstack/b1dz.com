/** Crypto markets: the top coins, movers, the whole-market totals, sentiment, trending coins and sectors. */
import { returnsBoard } from '../../lib/market.js';
import { SourceError, type CardDef, type Column, type Row } from '../../types.js';
import { COINS } from '../derivatives/crypto.js';
import { GECKO, PAPRIKA, STABLE_SYMBOLS, gecko, loadMarket, paprika, type MarketCoin } from './market-data.js';
import { DAY, RANGE_CHOICES, clip, list, minuteStamp, n, rangeDays, rec, share, str, sum, valueAt } from './util.js';

const sourceUrl = (source: string) => (source === GECKO ? 'https://www.coingecko.com/' : 'https://coinpaprika.com/');

const COIN_COLUMNS: Column[] = [
  { key: 'rank', label: '#', format: 'int' },
  { key: 'name', label: 'Coin', maxWidth: 22 },
  { key: 'symbol', label: 'Symbol' },
  { key: 'price', label: 'Price', format: 'usd' },
  { key: 'chg1h', label: '1h', format: 'signedPct' },
  { key: 'chg24h', label: '24h', format: 'signedPct' },
  { key: 'chg7d', label: '7d', format: 'signedPct' },
  { key: 'chg30d', label: '30d', format: 'signedPct' },
  { key: 'marketCap', label: 'Market cap', format: 'usdCompact' },
  { key: 'volume24h', label: '24h volume', format: 'usdCompact' },
];

const coinRow = (c: MarketCoin): Row => ({
  rank: c.rank,
  name: c.name,
  symbol: c.symbol,
  price: c.price,
  chg1h: c.chg1h,
  chg24h: c.chg24h,
  chg7d: c.chg7d,
  chg30d: c.chg30d,
  marketCap: c.marketCap,
  volume24h: c.volume24h,
});

const topCoins: CardDef = {
  id: 'crypto.top-coins',
  title: 'Top Coins by Market Cap',
  source: PAPRIKA,
  description: 'The largest coins by market value: price, change over 1 hour, 24 hours, 7 days and 30 days, market cap and 24-hour volume.',
  params: [{ name: 'limit', label: 'Rows', default: '50', choices: ['25', '50', '100', '200'] }],
  async run(ctx, params) {
    const m = await loadMarket(ctx);
    const limit = Math.min(200, Math.max(10, Number(params.limit) || 50));
    return {
      blocks: [{ kind: 'table', columns: COIN_COLUMNS, rows: m.coins.slice(0, limit).map(coinRow) }],
      source: m.source,
      sourceUrl: sourceUrl(m.source),
      asOf: minuteStamp(ctx),
      notes: ['Prices and volumes are volume-weighted across the exchanges the provider tracks. Market cap is price times the supply the provider counts.', ...m.skipped],
    };
  },
};

/** A stablecoin by symbol, or any coin that has barely moved over an hour, a day, a week and a month (pegged tokens). */
export function isPegged(c: MarketCoin): boolean {
  if (STABLE_SYMBOLS.has(c.symbol)) return true;
  const moves = [c.chg24h, c.chg7d, c.chg30d];
  return moves.every((m) => m !== null && Math.abs(m) < 1.5);
}

/** The biggest risers and fallers among coins with real turnover. Pegged tokens are left out. */
export function movers(coins: MarketCoin[], key: 'chg24h' | 'chg7d' | 'chg30d', universe: number, minVolume: number, count = 12): { up: MarketCoin[]; down: MarketCoin[] } {
  const pool = coins.filter((c) => c.rank <= universe && c[key] !== null && (c.volume24h ?? 0) >= minVolume && !isPegged(c));
  const sorted = [...pool].sort((a, b) => (b[key] as number) - (a[key] as number));
  return { up: sorted.filter((c) => (c[key] as number) > 0).slice(0, count), down: sorted.filter((c) => (c[key] as number) < 0).slice(-count).reverse() };
}

const WINDOWS: Record<string, 'chg24h' | 'chg7d' | 'chg30d'> = { '24h': 'chg24h', '7d': 'chg7d', '30d': 'chg30d' };

const moversCard: CardDef = {
  id: 'crypto.movers',
  title: 'Gainers and Losers',
  source: PAPRIKA,
  description: 'The biggest risers and fallers among the top coins over 24 hours, 7 days or 30 days, leaving out thinly traded names and stablecoins.',
  params: [
    { name: 'window', label: 'Window', default: '24h', choices: Object.keys(WINDOWS) },
    { name: 'universe', label: 'Among the top', default: '200', choices: ['100', '200', '500'] },
  ],
  async run(ctx, params) {
    const m = await loadMarket(ctx);
    const window = WINDOWS[params.window] ? params.window : '24h';
    const universe = Number(params.universe) || 200;
    const { up, down } = movers(m.coins, WINDOWS[window], universe, 1_000_000);
    if (!up.length && !down.length) throw new SourceError(m.source, 'no coins with enough volume to rank');
    const cols = COIN_COLUMNS.filter((c) => c.key !== 'chg1h');
    return {
      blocks: [
        { kind: 'table', title: `Gainers, ${window}`, columns: cols, rows: up.map(coinRow) },
        { kind: 'table', title: `Losers, ${window}`, columns: cols, rows: down.map(coinRow) },
      ],
      source: m.source,
      sourceUrl: sourceUrl(m.source),
      asOf: minuteStamp(ctx),
      notes: [`Ranked among the top ${universe} coins by market cap with at least $1M of 24-hour volume. Stablecoins and other pegged tokens are left out. A table is short when few coins moved that way.`, ...m.skipped],
    };
  },
};

const globalCard: CardDef = {
  id: 'crypto.global',
  title: 'Global Market',
  source: PAPRIKA,
  description: 'Total crypto market value and 24-hour volume, bitcoin and ether dominance, the stablecoin share, and how far the market is from its record.',
  async run(ctx) {
    const [g, m] = await Promise.all([paprika<unknown>(ctx, '/global', 300).then(rec), loadMarket(ctx)]);
    const total = n(g.market_cap_usd);
    if (total === null || !(total > 0)) throw new SourceError(PAPRIKA, 'no market total in the response');
    const cap = (sym: string) => m.coins.find((c) => c.symbol === sym)?.marketCap ?? null;
    const stable = sum(m.coins.filter((c) => STABLE_SYMBOLS.has(c.symbol)).map((c) => c.marketCap));
    const top = m.coins.slice(0, 10);
    const others = total - sum(top.map((c) => c.marketCap));
    const ath = n(g.market_cap_ath_value);
    return {
      blocks: [
        {
          kind: 'stats',
          items: [
            { label: 'Total market cap', value: total, format: 'usdCompact' },
            { label: 'Market cap, 24h', value: n(g.market_cap_change_24h), format: 'signedPct' },
            { label: '24h volume', value: n(g.volume_24h_usd), format: 'usdCompact' },
            { label: 'Volume, 24h', value: n(g.volume_24h_change_24h), format: 'signedPct' },
            { label: 'Bitcoin dominance', value: n(g.bitcoin_dominance_percentage) ?? share(cap('BTC'), total), format: 'pct' },
            { label: 'Ether dominance', value: share(cap('ETH'), total), format: 'pct' },
            { label: 'Stablecoin share', value: share(stable, total), format: 'pct' },
            { label: 'Record market cap', value: ath, format: 'usdCompact' },
            { label: 'Record set', value: str(g.market_cap_ath_date).slice(0, 10) || null },
            { label: 'From record', value: ath ? (total / ath - 1) * 100 : null, format: 'signedPct' },
            { label: 'Coins tracked', value: n(g.cryptocurrencies_number), format: 'int' },
          ],
        },
        {
          kind: 'chart',
          title: 'Share of total market cap (%)',
          xType: 'category',
          style: 'bar',
          yFormat: 'pct',
          categories: [...top.map((c) => c.symbol), 'Others'],
          series: [{ name: 'Share', points: [...top.map((c, i): [number, number] => [i, share(c.marketCap, total) ?? 0]), [top.length, Math.max(0, share(others, total) ?? 0)]] }],
        },
        {
          kind: 'table',
          columns: [
            { key: 'name', label: 'Coin' },
            { key: 'symbol', label: 'Symbol' },
            { key: 'marketCap', label: 'Market cap', format: 'usdCompact' },
            { key: 'share', label: 'Dominance', format: 'pct' },
            { key: 'chg24h', label: '24h', format: 'signedPct' },
            { key: 'chg7d', label: '7d', format: 'signedPct' },
          ],
          rows: top.map((c) => ({ name: c.name, symbol: c.symbol, marketCap: c.marketCap, share: share(c.marketCap, total), chg24h: c.chg24h, chg7d: c.chg7d })),
        },
      ],
      source: m.source === PAPRIKA ? PAPRIKA : `${PAPRIKA}, ${m.source}`,
      sourceUrl: 'https://coinpaprika.com/market-overview/',
      asOf: n(g.last_updated) ? new Date((n(g.last_updated) as number) * 1000).toISOString().slice(0, 16) + 'Z' : minuteStamp(ctx),
      notes: ['Dominance is a coin\'s market cap as a share of the total. The stablecoin share sums the dollar stablecoins among the top 500 coins.', ...m.skipped],
    };
  },
};

const athCard: CardDef = {
  id: 'crypto.ath',
  title: 'Distance from All-Time High',
  source: PAPRIKA,
  description: 'How far each of the top coins trades below its record price, with the record and the date it was set.',
  params: [{ name: 'limit', label: 'Rows', default: '40', choices: ['20', '40', '100'] }],
  async run(ctx, params) {
    const m = await loadMarket(ctx);
    const limit = Number(params.limit) || 40;
    const coins = m.coins.filter((c) => !STABLE_SYMBOLS.has(c.symbol) && c.athPrice !== null).slice(0, limit);
    return {
      blocks: [
        {
          kind: 'table',
          columns: [
            { key: 'rank', label: '#', format: 'int' },
            { key: 'name', label: 'Coin', maxWidth: 22 },
            { key: 'symbol', label: 'Symbol' },
            { key: 'price', label: 'Price', format: 'usd' },
            { key: 'ath', label: 'Record', format: 'usd' },
            { key: 'athDate', label: 'Set on' },
            { key: 'fromAth', label: 'From record', format: 'signedPct' },
            { key: 'toAth', label: 'Gain to regain it', format: 'signedPct' },
            { key: 'chg1y', label: '1Y', format: 'signedPct' },
          ],
          rows: coins.map((c) => ({
            rank: c.rank,
            name: c.name,
            symbol: c.symbol,
            price: c.price,
            ath: c.athPrice,
            athDate: c.athDate,
            fromAth: c.fromAth ?? (c.athPrice ? (c.price / c.athPrice - 1) * 100 : null),
            toAth: c.athPrice ? (c.athPrice / c.price - 1) * 100 : null,
            chg1y: c.chg1y,
          })),
        },
      ],
      source: m.source,
      sourceUrl: sourceUrl(m.source),
      asOf: minuteStamp(ctx),
      notes: ['Records are the provider\'s own volume-weighted prices, so they can differ from the high printed on any one exchange. Stablecoins are left out.', ...m.skipped],
    };
  },
};

const performance: CardDef = {
  id: 'crypto.performance',
  title: 'Major Coins: Returns',
  source: 'Coinbase',
  description: 'Returns of the major coins against the dollar over one day, one week, one month, three months, the year to date and one year.',
  async run(ctx) {
    const b = await returnsBoard(ctx, COINS.map((c) => ({ symbol: `${c}-USD`, label: c })));
    return { blocks: [b.block], source: b.source, sourceUrl: 'https://www.coinbase.com/explore', notes: b.notes.map((x) => x.replace('split-adjusted, dividends and coupons not included', 'days close at 00:00 UTC')) };
  },
};

// ---------------------------------------------------------------- fear and greed

export interface FngPoint {
  t: number;
  value: number;
  label: string;
}

/** alternative.me `GET /fng/` (newest first) to points, oldest first. */
export function parseFearGreed(body: unknown): FngPoint[] {
  const out: FngPoint[] = [];
  for (const raw of list(rec(body).data)) {
    const d = rec(raw);
    const value = n(d.value);
    const ts = n(d.timestamp);
    if (value === null || ts === null) continue;
    out.push({ t: ts * 1000, value, label: str(d.value_classification) });
  }
  return out.sort((a, b) => a.t - b.t);
}

export function fngLabel(v: number): string {
  return v < 25 ? 'Extreme Fear' : v < 47 ? 'Fear' : v < 55 ? 'Neutral' : v < 76 ? 'Greed' : 'Extreme Greed';
}

const fearGreed: CardDef = {
  id: 'crypto.fear-greed',
  title: 'Fear and Greed Index',
  source: 'alternative.me',
  description: 'The crypto Fear and Greed Index (0 is extreme fear, 100 is extreme greed) today and through time.',
  params: [{ name: 'range', label: 'Range', default: '1Y', choices: RANGE_CHOICES }],
  async run(ctx, params) {
    const days = Math.min(rangeDays(params.range), 5000);
    const pts = parseFearGreed(await ctx.http.json<unknown>(`https://api.alternative.me/fng/?limit=${Math.max(days, 400)}`, { source: 'alternative.me', ttl: 1800 }));
    if (!pts.length) throw new SourceError('alternative.me', 'no index values returned');
    const series = pts.map((p): [number, number] => [p.t, p.value]);
    const last = pts[pts.length - 1];
    const at = (d: number) => valueAt(series, last.t - d * DAY);
    const year = series.filter((p) => p[0] >= last.t - 365 * DAY).map((p) => p[1]);
    const shown = clip(series, params.range);
    const tag = (v: number | null) => (v === null ? null : `${v} (${fngLabel(v)})`);
    return {
      blocks: [
        {
          kind: 'stats',
          items: [
            { label: 'Now', value: `${last.value} (${last.label || fngLabel(last.value)})` },
            { label: 'Yesterday', value: tag(at(1)) },
            { label: 'A week ago', value: tag(at(7)) },
            { label: 'A month ago', value: tag(at(30)) },
            { label: '1-year average', value: year.length ? sum(year) / year.length : null, format: 'num', digits: 0 },
            { label: '1-year low', value: year.length ? Math.min(...year) : null, format: 'int' },
            { label: '1-year high', value: year.length ? Math.max(...year) : null, format: 'int' },
            { label: 'Days in fear, last 90', value: series.filter((p) => p[0] >= last.t - 90 * DAY && p[1] < 47).length, format: 'int' },
          ],
        },
        { kind: 'chart', title: 'Fear and Greed Index', xType: 'time', yFormat: 'num', yDigits: 0, series: [{ name: 'Index', points: shown }] },
      ],
      sourceUrl: 'https://alternative.me/crypto/fear-and-greed-index/',
      asOf: new Date(last.t).toISOString().slice(0, 10),
      notes: ['Published once a day by alternative.me from bitcoin volatility, momentum and volume, social media, dominance and search trends. Below 25 is extreme fear, above 75 extreme greed.'],
    };
  },
};

// ---------------------------------------------------------------- CoinGecko: trending and categories

export interface TrendingCoin {
  name: string;
  symbol: string;
  rank: number | null;
  price: number | null;
  chg24h: number | null;
  marketCap: number | null;
  volume: number | null;
}

/** CoinGecko `GET /search/trending` to the trending coins, most searched first. */
export function parseTrending(body: unknown): TrendingCoin[] {
  const out: TrendingCoin[] = [];
  for (const raw of list(rec(body).coins)) {
    const item = rec(rec(raw).item);
    const data = rec(item.data);
    if (!str(item.name)) continue;
    out.push({
      name: str(item.name),
      symbol: str(item.symbol).toUpperCase(),
      rank: n(item.market_cap_rank),
      price: n(data.price),
      chg24h: n(rec(data.price_change_percentage_24h).usd),
      marketCap: n(data.market_cap),
      volume: n(data.total_volume),
    });
  }
  return out;
}

const trending: CardDef = {
  id: 'crypto.trending',
  title: 'Trending Coins',
  source: GECKO,
  description: 'The coins people searched for most on CoinGecko in the last 24 hours, with price, change and size.',
  async run(ctx) {
    const body = await gecko<unknown>(ctx, '/search/trending', 1800);
    const coins = parseTrending(body);
    if (!coins.length) throw new SourceError(GECKO, 'no trending coins returned');
    const cats = list(rec(body).categories).map((c) => rec(c));
    return {
      blocks: [
        {
          kind: 'table',
          title: 'Most searched coins',
          columns: [
            { key: 'pos', label: '#', format: 'int' },
            { key: 'name', label: 'Coin', maxWidth: 24 },
            { key: 'symbol', label: 'Symbol' },
            { key: 'rank', label: 'Cap rank', format: 'int' },
            { key: 'price', label: 'Price', format: 'usd' },
            { key: 'chg24h', label: '24h', format: 'signedPct' },
            { key: 'marketCap', label: 'Market cap', format: 'usdCompact' },
            { key: 'volume', label: '24h volume', format: 'usdCompact' },
          ],
          rows: coins.map((c, i) => ({ pos: i + 1, ...c })),
        },
        ...(cats.length
          ? [
              {
                kind: 'table' as const,
                title: 'Trending sectors',
                columns: [
                  { key: 'name', label: 'Sector', maxWidth: 36 },
                  { key: 'coins', label: 'Coins', format: 'int' as const },
                  { key: 'marketCap', label: 'Market cap', format: 'usdCompact' as const },
                  { key: 'chg24h', label: '24h', format: 'signedPct' as const },
                  { key: 'volume', label: '24h volume', format: 'usdCompact' as const },
                ],
                rows: cats.map((c) => {
                  const d = rec(c.data);
                  return { name: str(c.name), coins: n(c.coins_count), marketCap: n(d.market_cap), chg24h: n(rec(d.market_cap_change_percentage_24h).usd), volume: n(d.total_volume) };
                }),
              },
            ]
          : []),
      ],
      sourceUrl: 'https://www.coingecko.com/en/highlights/trending-crypto',
      asOf: minuteStamp(ctx),
      notes: ['Ranked by searches on CoinGecko over the last 24 hours, not by price move. Refreshed here every 30 minutes.'],
    };
  },
};

export interface Category {
  name: string;
  marketCap: number;
  chg24h: number | null;
  volume: number | null;
}

/** CoinGecko `GET /coins/categories` to sectors, largest first. */
export function parseCategories(body: unknown): Category[] {
  const out: Category[] = [];
  for (const raw of list(body)) {
    const c = rec(raw);
    const cap = n(c.market_cap);
    if (!str(c.name) || cap === null || !(cap > 0)) continue;
    out.push({ name: str(c.name), marketCap: cap, chg24h: n(c.market_cap_change_24h), volume: n(c.volume_24h) });
  }
  return out.sort((a, b) => b.marketCap - a.marketCap);
}

const categories: CardDef = {
  id: 'crypto.categories',
  title: 'Sectors',
  source: GECKO,
  description: 'Crypto sectors by market value (layer 1, DeFi, stablecoins, memes, AI and more) with the 24-hour change and volume.',
  params: [{ name: 'sort', label: 'Sort by', default: 'size', choices: ['size', 'gainers', 'losers', 'volume'] }],
  async run(ctx, params) {
    const all = parseCategories(await gecko<unknown>(ctx, '/coins/categories', 3600));
    if (!all.length) throw new SourceError(GECKO, 'no sectors returned');
    const big = all.filter((c) => c.marketCap >= 100_000_000);
    const sorted =
      params.sort === 'gainers'
        ? [...big].sort((a, b) => (b.chg24h ?? -1e9) - (a.chg24h ?? -1e9))
        : params.sort === 'losers'
          ? [...big].sort((a, b) => (a.chg24h ?? 1e9) - (b.chg24h ?? 1e9))
          : params.sort === 'volume'
            ? [...big].sort((a, b) => (b.volume ?? 0) - (a.volume ?? 0))
            : all;
    return {
      blocks: [
        {
          kind: 'table',
          columns: [
            { key: 'name', label: 'Sector', maxWidth: 40 },
            { key: 'marketCap', label: 'Market cap', format: 'usdCompact' },
            { key: 'chg24h', label: '24h', format: 'signedPct' },
            { key: 'volume', label: '24h volume', format: 'usdCompact' },
          ],
          rows: sorted.slice(0, 40).map((c) => ({ ...c })),
        },
      ],
      sourceUrl: 'https://www.coingecko.com/en/categories',
      asOf: minuteStamp(ctx),
      notes: ['A coin can sit in several sectors, so the sectors overlap and do not sum to the market. Gainers, losers and volume rank sectors of at least $100M. Refreshed here once an hour.'],
    };
  },
};

export const marketCards: CardDef[] = [topCoins, globalCard, moversCard, athCard, performance, fearGreed, trending, categories];
