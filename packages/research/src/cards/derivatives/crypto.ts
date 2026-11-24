/** Crypto dashboard: spot boards and history (Coinbase Exchange, Kraken), Deribit order book and option chain. */
import { firstOf, num } from '../../http.js';
import { pctChange } from '../../format.js';
import { SourceError, type CardDef, type Ctx, type ParamSpec, type Row } from '../../types.js';
import { DERIBIT, deribit, parseInstrument } from './deribit.js';
import { EXPIRY_PARAM, chainBlocks, finish, setup, statsBlocks } from './options.js';

export const COINS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'ADA', 'AVAX', 'LINK', 'LTC', 'BCH', 'DOT', 'UNI', 'AAVE', 'XLM', 'SUI', 'HBAR'];

export const CURRENCY_PARAM: ParamSpec = { name: 'currency', label: 'Coin', default: 'BTC', choices: ['BTC', 'ETH'] };

export function coinOf(params: Record<string, string>): 'BTC' | 'ETH' {
  const c = (params.currency ?? 'BTC').trim().toUpperCase();
  if (c !== 'BTC' && c !== 'ETH') throw new SourceError(DERIBIT, `options are listed for BTC and ETH, not "${c}"`);
  return c;
}

// ---------------------------------------------------------------- spot board

export interface SpotRow {
  pair: string;
  last: number;
  open: number | null;
  high: number | null;
  low: number | null;
  /** Base-asset volume over the provider's window. */
  volume: number | null;
}

type CoinbaseStats = Record<string, { stats_24hour?: Record<string, string | undefined> } | undefined>;

/** Coinbase Exchange `GET /products/stats` (all products, rolling 24 hours) to rows for the wanted USD pairs. */
export function parseCoinbaseStats(body: CoinbaseStats, coins: string[]): SpotRow[] {
  const out: SpotRow[] = [];
  for (const coin of coins) {
    const s = body[`${coin}-USD`]?.stats_24hour;
    const last = num(s?.last);
    if (!s || last === null || !(last > 0)) continue;
    out.push({ pair: `${coin}-USD`, last, open: num(s.open), high: num(s.high), low: num(s.low), volume: num(s.volume) });
  }
  return out;
}

const KRAKEN_BASE: Record<string, string> = { BTC: 'XBT', DOGE: 'XDG' };

interface KrakenTicker {
  error?: string[];
  result?: Record<string, { c?: string[]; o?: string; h?: string[]; l?: string[]; v?: string[] }>;
}

/**
 * Kraken `Ticker` to rows. Kraken renames pairs in the response (XBTUSD
 * comes back as XXBTZUSD), so each wanted coin is matched on its base code.
 * `o` is today's opening price (00:00 UTC); h, l and v index 1 are the last 24 hours.
 */
export function parseKrakenTicker(body: KrakenTicker, coins: string[]): SpotRow[] {
  const out: SpotRow[] = [];
  const keys = Object.keys(body.result ?? {});
  for (const coin of coins) {
    const base = KRAKEN_BASE[coin] ?? coin;
    const key = keys.find((k) => k === `${base}USD` || k === `X${base}ZUSD`);
    const t = key ? body.result?.[key] : undefined;
    const last = num(t?.c?.[0]);
    if (!t || last === null) continue;
    out.push({ pair: `${coin}-USD`, last, open: num(t.o), high: num(t.h?.[1]), low: num(t.l?.[1]), volume: num(t.v?.[1]) });
  }
  return out;
}

const spotCard: CardDef = {
  id: 'derivatives.crypto-spot',
  title: 'Major Coins',
  source: 'Coinbase',
  description: 'Spot price, 24-hour change, range and dollar volume for the major coins, ranked by volume.',
  async run(ctx) {
    const got = await firstOf([
      {
        name: 'Coinbase',
        run: async () => {
          const rows = parseCoinbaseStats(await ctx.http.json<CoinbaseStats>('https://api.exchange.coinbase.com/products/stats', { source: 'Coinbase', ttl: 60 }), COINS);
          if (!rows.length) throw new SourceError('Coinbase', 'no USD pairs in the statistics response');
          return rows;
        },
      },
      {
        name: 'Kraken',
        run: async () => {
          const pairs = COINS.map((c) => `${KRAKEN_BASE[c] ?? c}USD`).join(',');
          const body = await ctx.http.json<KrakenTicker>(`https://api.kraken.com/0/public/Ticker?pair=${pairs}`, { source: 'Kraken', ttl: 60 });
          const rows = parseKrakenTicker(body, COINS);
          if (!rows.length) throw new SourceError('Kraken', body.error?.[0] ?? 'no pairs returned');
          return rows;
        },
      },
    ]);
    const rows: Row[] = got.value
      .map((r) => ({
        pair: r.pair,
        last: r.last,
        chg: pctChange(r.last, r.open),
        low: r.low,
        high: r.high,
        usdVol: r.volume === null ? null : r.volume * r.last,
      }))
      .sort((a, b) => (b.usdVol ?? 0) - (a.usdVol ?? 0));
    const kraken = got.source === 'Kraken';
    return {
      blocks: [
        {
          kind: 'table',
          columns: [
            { key: 'pair', label: 'Pair' },
            { key: 'last', label: 'Last', format: 'usd' },
            { key: 'chg', label: kraken ? 'Chg since 00:00 UTC' : '24h chg', format: 'signedPct', digits: 2 },
            { key: 'low', label: '24h low', format: 'usd' },
            { key: 'high', label: '24h high', format: 'usd' },
            { key: 'usdVol', label: '24h volume', format: 'usdCompact' },
          ],
          rows,
        },
      ],
      source: got.source,
      sourceUrl: kraken ? 'https://www.kraken.com/prices' : 'https://www.coinbase.com/explore',
      asOf: ctx.now().toISOString().slice(0, 16) + 'Z',
      notes: [`Volume is on ${got.source} only, not the whole market.`, ...got.skipped],
    };
  },
};

// ---------------------------------------------------------------- spot history

const RANGE_DAYS: Record<string, number> = { '1M': 30, '3M': 91, '6M': 182, '1Y': 365, '2Y': 730, '5Y': 1826, '10Y': 3652, MAX: 3652 };

/** Coinbase candles ([time s, low, high, open, close, volume], newest first) to [ms, close, volume], oldest first. */
export function parseCoinbaseCandles(body: unknown): [number, number, number][] {
  if (!Array.isArray(body)) return [];
  const out: [number, number, number][] = [];
  for (const c of body) {
    if (Array.isArray(c) && typeof c[0] === 'number' && typeof c[4] === 'number') out.push([c[0] * 1000, c[4], typeof c[5] === 'number' ? c[5] : 0]);
  }
  return out.sort((a, b) => a[0] - b[0]);
}

/** Kraken OHLC ([time s, open, high, low, close, vwap, volume, count]) to [ms, close, volume]. */
export function parseKrakenOhlc(body: { error?: string[]; result?: Record<string, unknown> }): [number, number, number][] {
  const key = Object.keys(body.result ?? {}).find((k) => k !== 'last');
  const rows = key ? body.result?.[key] : undefined;
  if (!Array.isArray(rows)) return [];
  const out: [number, number, number][] = [];
  for (const c of rows) {
    const close = Array.isArray(c) ? num(c[4]) : null;
    if (Array.isArray(c) && typeof c[0] === 'number' && close !== null) out.push([c[0] * 1000, close, num(c[6]) ?? 0]);
  }
  return out;
}

async function coinbaseDaily(ctx: Ctx, pair: string, days: number): Promise<[number, number, number][]> {
  const all = new Map<number, [number, number, number]>();
  const DAY = 86_400_000;
  let end = Math.floor(ctx.now().getTime() / DAY) * DAY + DAY;
  const stop = end - days * DAY;
  // 300 candles per request is the documented maximum.
  for (let page = 0; page < 14 && end > stop; page++) {
    const start = Math.max(stop, end - 300 * DAY);
    const url = `https://api.exchange.coinbase.com/products/${encodeURIComponent(pair)}/candles?granularity=86400&start=${new Date(start).toISOString()}&end=${new Date(end).toISOString()}`;
    const rows = parseCoinbaseCandles(await ctx.http.json<unknown>(url, { source: 'Coinbase', ttl: 900 }));
    if (!rows.length) break;
    for (const r of rows) all.set(r[0], r);
    end = start;
  }
  if (!all.size) throw new SourceError('Coinbase', `no daily candles for ${pair}`);
  return [...all.values()].sort((a, b) => a[0] - b[0]);
}

async function krakenDaily(ctx: Ctx, pair: string, days: number): Promise<[number, number, number][]> {
  const [base, quote] = pair.split('-');
  const since = Math.floor(ctx.now().getTime() / 1000) - days * 86_400;
  const url = `https://api.kraken.com/0/public/OHLC?pair=${KRAKEN_BASE[base] ?? base}${quote ?? 'USD'}&interval=1440&since=${since}`;
  const body = await ctx.http.json<{ error?: string[]; result?: Record<string, unknown> }>(url, { source: 'Kraken', ttl: 900 });
  const rows = parseKrakenOhlc(body);
  if (!rows.length) throw new SourceError('Kraken', body.error?.[0] ?? `no daily candles for ${pair}`);
  return rows;
}

const historyCard: CardDef = {
  id: 'derivatives.crypto-history',
  title: 'Spot Price History',
  source: 'Coinbase',
  description: 'Daily closing price of a coin against the dollar, with returns over standard horizons.',
  params: [
    { name: 'symbol', label: 'Pair', default: 'BTC-USD', hint: 'coin-USD, e.g. BTC-USD, ETH-USD, SOL-USD' },
    { name: 'range', label: 'Range', default: '1Y', choices: Object.keys(RANGE_DAYS) },
  ],
  async run(ctx, params) {
    let pair = (params.symbol ?? 'BTC-USD').trim().toUpperCase();
    if (!pair.includes('-')) pair = `${pair.replace(/USD$/, '') || pair}-USD`;
    const range = (params.range ?? '1Y').toUpperCase();
    const days = RANGE_DAYS[range] ?? 365;
    const got = await firstOf([
      { name: 'Coinbase', run: () => coinbaseDaily(ctx, pair, days) },
      { name: 'Kraken', run: () => krakenDaily(ctx, pair, days) },
    ]);
    const bars = got.value;
    const last = bars[bars.length - 1];
    const back = (n: number): number | null => {
      const t = last[0] - n * 86_400_000;
      const b = [...bars].reverse().find((x) => x[0] <= t);
      return b ? pctChange(last[1], b[1]) : null;
    };
    const closes = bars.map((b) => b[1]);
    const notes = [...got.skipped];
    const spanDays = Math.round((last[0] - bars[0][0]) / 86_400_000);
    if (spanDays < days - 5) notes.push(`${got.source} returned ${spanDays} days of history for ${pair}, less than the ${range} asked for.`);
    return {
      blocks: [
        {
          kind: 'stats',
          items: [
            { label: 'Last close', value: last[1], format: 'usd' },
            { label: '1 day', value: back(1), format: 'signedPct' },
            { label: '7 days', value: back(7), format: 'signedPct' },
            { label: '30 days', value: back(30), format: 'signedPct' },
            { label: '90 days', value: back(90), format: 'signedPct' },
            { label: `${range} high`, value: Math.max(...closes), format: 'usd' },
            { label: `${range} low`, value: Math.min(...closes), format: 'usd' },
            { label: 'From high', value: pctChange(last[1], Math.max(...closes)), format: 'signedPct' },
          ],
        },
        { kind: 'chart', title: `${pair} daily close`, xType: 'time', yFormat: 'usd', series: [{ name: pair, points: bars.map((b) => [b[0], b[1]]) }] },
      ],
      source: got.source,
      sourceUrl: got.source === 'Kraken' ? 'https://www.kraken.com/prices' : `https://www.coinbase.com/advanced-trade/spot/${pair}`,
      asOf: new Date(last[0]).toISOString().slice(0, 10),
      notes: [`Daily candles close at 00:00 UTC; the last bar is the day in progress. Prices are ${got.source}'s own, not a market-wide average.`, ...notes],
    };
  },
};

// ---------------------------------------------------------------- order book

interface OrderBook {
  timestamp?: number;
  instrument_name?: string;
  bids?: [number, number][];
  asks?: [number, number][];
  mark_price?: number;
  index_price?: number;
  last_price?: number;
  best_bid_price?: number;
  best_ask_price?: number;
  open_interest?: number;
  funding_8h?: number;
  current_funding?: number;
  mark_iv?: number;
  stats?: { volume?: number; volume_usd?: number; price_change?: number; high?: number; low?: number };
}

/** Cumulative size at each level, walking away from the touch. */
export function cumulative(levels: [number, number][]): [number, number][] {
  let run = 0;
  return levels.map(([price, size]) => {
    run += size;
    return [price, run];
  });
}

const bookCard: CardDef = {
  id: 'derivatives.crypto-order-book',
  title: 'Order Book',
  source: 'Deribit',
  description: 'Top bids and asks and cumulative depth for a Deribit instrument.',
  params: [{ name: 'instrument', label: 'Instrument', default: 'BTC-PERPETUAL', hint: 'Deribit name: BTC-PERPETUAL, ETH-PERPETUAL, BTC-25DEC26, BTC-25DEC26-60000-C' }],
  async run(ctx, params) {
    const name = (params.instrument ?? 'BTC-PERPETUAL').trim().toUpperCase();
    const id = parseInstrument(name);
    if (!id) throw new SourceError(DERIBIT, `"${name}" is not a Deribit instrument name (try BTC-PERPETUAL)`);
    const book = await deribit<OrderBook>(ctx, 'get_order_book', { instrument_name: name, depth: 50 }, 15);
    const bids = book.bids ?? [];
    const asks = book.asks ?? [];
    if (!bids.length && !asks.length) throw new SourceError(DERIBIT, `${name}: the book is empty`);
    const bidCum = cumulative(bids);
    const askCum = cumulative(asks);
    const rows: Row[] = [];
    for (let i = 0; i < 15; i++) {
      if (!bids[i] && !asks[i]) break;
      rows.push({ level: i + 1, bidCum: bidCum[i]?.[1], bidSize: bids[i]?.[1], bid: bids[i]?.[0], ask: asks[i]?.[0], askSize: asks[i]?.[1], askCum: askCum[i]?.[1] });
    }
    const bb = book.best_bid_price ?? bids[0]?.[0];
    const ba = book.best_ask_price ?? asks[0]?.[0];
    const inverse = id.kind !== 'option' && !id.currency.includes('_');
    const unit = id.kind === 'option' ? 'contracts' : inverse ? 'USD' : 'contracts';
    const coinPriced = id.kind === 'option' && !id.currency.includes('_');
    const priceDigits = coinPriced ? 4 : 2;
    return {
      blocks: [
        {
          kind: 'stats',
          items: [
            { label: 'Mark', value: book.mark_price, format: 'num', digits: priceDigits },
            { label: 'Index', value: book.index_price, format: 'num', digits: 2 },
            { label: 'Last', value: book.last_price, format: 'num', digits: priceDigits },
            { label: 'Spread', value: bb && ba ? ba - bb : null, format: 'num', digits: priceDigits },
            { label: 'Spread, bp of mid', value: bb && ba ? ((ba - bb) / ((ba + bb) / 2)) * 10_000 : null, format: 'num', digits: 2 },
            { label: `Open interest (${unit})`, value: book.open_interest, format: 'compact' },
            { label: '24h volume (USD)', value: book.stats?.volume_usd, format: 'usdCompact' },
            { label: '24h change', value: book.stats?.price_change, format: 'signedPct' },
            ...(id.kind === 'perpetual' ? [{ label: 'Funding, 8h', value: book.funding_8h == null ? null : book.funding_8h * 100, format: 'pct' as const, digits: 4 }] : []),
            ...(id.kind === 'option' ? [{ label: 'Mark IV', value: book.mark_iv, format: 'pct' as const, digits: 1 }] : []),
          ],
        },
        {
          kind: 'chart',
          title: `${name}: cumulative depth, top ${Math.max(bids.length, asks.length)} levels (${unit})`,
          xType: 'number',
          xLabel: 'Price',
          yFormat: 'compact',
          series: [
            { name: 'Bids', points: [...bidCum].reverse() },
            { name: 'Asks', points: askCum },
          ],
        },
        {
          kind: 'table',
          columns: [
            { key: 'level', label: '#', format: 'int' },
            { key: 'bidCum', label: 'Cum. bid', format: 'compact', digits: 1 },
            { key: 'bidSize', label: 'Bid size', format: 'compact', digits: 1 },
            { key: 'bid', label: 'Bid', format: 'num', digits: priceDigits },
            { key: 'ask', label: 'Ask', format: 'num', digits: priceDigits },
            { key: 'askSize', label: 'Ask size', format: 'compact', digits: 1 },
            { key: 'askCum', label: 'Cum. ask', format: 'compact', digits: 1 },
          ],
          rows,
        },
      ],
      sourceUrl: `https://www.deribit.com/${id.kind === 'option' ? 'options' : 'futures'}/${name}`,
      asOf: book.timestamp ? new Date(book.timestamp).toISOString().slice(0, 19) + 'Z' : undefined,
      notes: [
        `Sizes are in ${unit}${unit === 'USD' ? ' (inverse contracts are sized in dollars of notional)' : ''}.${coinPriced ? ` Option prices are in ${id.currency}.` : ''}`,
      ],
    };
  },
};

// ---------------------------------------------------------------- Deribit option chain

const cryptoOptionsCard: CardDef = {
  id: 'derivatives.crypto-options',
  title: 'Crypto Option Chain',
  source: 'Deribit',
  description: 'Deribit BTC or ETH calls and puts around the money for one expiry: prices in USD, mark implied volatility, delta, open interest.',
  params: [CURRENCY_PARAM, EXPIRY_PARAM],
  async run(ctx, params) {
    const s = await setup(ctx, { symbol: coinOf(params), expiry: params.expiry });
    return finish(s.chain, chainBlocks(s));
  },
};

const cryptoExpiriesCard: CardDef = {
  id: 'derivatives.crypto-options-expiries',
  title: 'Crypto Option Activity by Expiry',
  source: 'Deribit',
  description: 'Deribit BTC or ETH option open interest and 24-hour volume by expiry, with put/call ratios.',
  params: [CURRENCY_PARAM, EXPIRY_PARAM],
  async run(ctx, params) {
    const s = await setup(ctx, { symbol: coinOf(params), expiry: params.expiry });
    return finish(s.chain, statsBlocks(s, ctx.now()));
  },
};

export const cryptoCards: CardDef[] = [spotCard, historyCard, bookCard, cryptoOptionsCard, cryptoExpiriesCard];
