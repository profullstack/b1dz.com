/**
 * Shared market data: quotes and price history for any symbol, behind a
 * provider chain. Every area module uses this instead of calling a quote
 * provider directly, so a blocked provider is substituted in one place.
 *
 * Symbols use the common exchange-suffix convention:
 *   AAPL, BRK-B          U.S. stocks and ETFs
 *   RY.TO, SHEL.L, 7203.T  listings elsewhere (suffix = exchange)
 *   ^GSPC, ^VIX          indices
 *   EURUSD=X             currency pairs
 *   ES=F, CL=F, CLZ26.NYM  futures (front month, or a dated contract)
 *   BTC-USD              crypto
 *
 * Providers, in order:
 *   U.S. stocks and ETFs   Nasdaq, NicheDB (the Alpaca-fed history the b1dz
 *                          console reads), then Yahoo
 *   indices                Cboe daily index files (^GSPC ^VIX ^RUT ^DJI ^OEX ^RUI
 *                          ^VVIX ^VIX9D ^VIX3M ^SKEW ^MXEA ^MXEF), Nasdaq
 *                          (^IXIC ^NDX ^SOX and any other Nasdaq-calculated
 *                          index by its own code, e.g. ^OMXS30), then Yahoo
 *   crypto                 Coinbase Exchange, Kraken, then Yahoo
 *   currency pairs         Frankfurter (ECB daily reference rates), then Yahoo
 *   Canada (.TO, .V, ^GSPTSE ^TX60 ^JX)  TMX Money, then Yahoo
 *   futures                Coinbase Derivatives for crude, natural gas, gold,
 *                          silver, copper, platinum, bitcoin and ether (that
 *                          exchange's own contracts; 24-hour change), then Yahoo
 *   other futures, other non-U.S. listings and indices   Yahoo only
 * History is price return: closes are split-adjusted but not
 * dividend-adjusted. Index quotes from Cboe files are previous-close values.
 */
import { pctChange } from '../format.js';
import { firstOf, parseCsv } from '../http.js';
import { SourceError, type Ctx, type Row, type TableBlock } from '../types.js';
import { CDE, cdeBars, cdeContract, cdeCovers } from './exchange-futures.js';
import { NICHEDB, nichedbBars } from './nichedb.js';
import { NASDAQ, nasdaqHistory, nasdaqHistoryAuto, nasdaqInfo, parseTrade, type NasdaqInfo } from './nasdaq.js';
import { YAHOO, yahooChart } from './yahoo.js';

export type AssetClass = 'stock' | 'index' | 'fx' | 'future' | 'crypto';
export type Range = '1M' | '3M' | '6M' | '1Y' | '2Y' | '5Y' | '10Y' | 'MAX';
export const RANGES: Range[] = ['1M', '3M', '6M', '1Y', '2Y', '5Y', '10Y', 'MAX'];

export interface Quote {
  symbol: string;
  name?: string;
  /** null when no provider could price the symbol. */
  price: number | null;
  change: number | null;
  changePct: number | null;
  prevClose?: number | null;
  currency?: string;
  exchange?: string;
  /** ISO time of the last trade when the provider gives one. */
  time?: string;
  /** The provider that answered, or the reason nothing did. */
  source: string;
}

export interface Bar {
  /** ms since epoch (start of the bar, UTC). */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number | null;
}

export interface History {
  symbol: string;
  bars: Bar[];
  source: string;
  currency?: string;
}

const DAY = 86_400_000;
const CRYPTO_QUOTES = 'USD|USDT|USDC|EUR|GBP|BTC|ETH';
const CRYPTO_RE = new RegExp(`^[A-Z0-9]{2,10}-(${CRYPTO_QUOTES})$`);
const FUTURE_RE = /(=F|\.(NYM|CMX|CBT|CME|NYB|CBF))$/;

export function classify(symbol: string): AssetClass {
  const s = symbol.trim().toUpperCase();
  if (s.startsWith('^')) return 'index';
  if (s.endsWith('=X')) return 'fx';
  if (FUTURE_RE.test(s)) return 'future';
  if (CRYPTO_RE.test(s)) return 'crypto';
  return 'stock';
}

/** First day of the range, counting back from `now`. MAX returns 1970-01-01. */
export function rangeStart(range: Range, now: Date): Date {
  if (range === 'MAX') return new Date(0);
  const months = { '1M': 1, '3M': 3, '6M': 6, '1Y': 12, '2Y': 24, '5Y': 60, '10Y': 120 }[range] ?? 12;
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth() - months;
  const d = now.getUTCDate();
  // Clamp to the last day of the target month (31 Mar minus 1M is 28/29 Feb).
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(d, lastDay)));
}

// ---------------------------------------------------------------- indices

const CBOE = 'Cboe';
/** Cboe daily index history files. `scale` converts a scaled product to the headline index. */
const CBOE_FILES: Record<string, { file: string; name: string; scale?: number }> = {
  '^GSPC': { file: 'SPX', name: 'S&P 500' },
  '^SPX': { file: 'SPX', name: 'S&P 500' },
  '^VIX': { file: 'VIX', name: 'Cboe Volatility Index' },
  '^RUT': { file: 'RUT', name: 'Russell 2000' },
  '^RUI': { file: 'RUI', name: 'Russell 1000' },
  '^DJI': { file: 'DJX', name: 'Dow Jones Industrial Average', scale: 100 },
  '^OEX': { file: 'OEX', name: 'S&P 100' },
  '^VVIX': { file: 'VVIX', name: 'Cboe VIX of VIX' },
  '^VIX9D': { file: 'VIX9D', name: 'Cboe 9-Day Volatility' },
  '^VIX3M': { file: 'VIX3M', name: 'Cboe 3-Month Volatility' },
  '^SKEW': { file: 'SKEW', name: 'Cboe SKEW Index' },
  '^MXEA': { file: 'MXEA', name: 'MSCI EAFE' },
  '^MXEF': { file: 'MXEF', name: 'MSCI Emerging Markets' },
};
const NASDAQ_INDEX: Record<string, string> = { '^IXIC': 'COMP', '^COMP': 'COMP', '^NDX': 'NDX', '^SOX': 'SOX' };

/** Cboe index file: "DATE,SPX" (close only) or "DATE,OPEN,HIGH,LOW,CLOSE"; dates are MM/DD/YYYY. */
export function parseCboeCsv(text: string, scale = 1): Bar[] {
  const rows = parseCsv(text);
  const out: Bar[] = [];
  for (const r of rows.slice(1)) {
    const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec((r[0] ?? '').trim());
    if (!m) continue;
    const vals = r.slice(1).map((x) => Number(x));
    if (!vals.length || vals.some((x) => !Number.isFinite(x))) continue;
    const t = Date.UTC(Number(m[3]), Number(m[1]) - 1, Number(m[2]));
    const c = vals[vals.length - 1] * scale;
    if (vals.length >= 4) out.push({ t, o: vals[0] * scale, h: vals[1] * scale, l: vals[2] * scale, c, v: null });
    else out.push({ t, o: c, h: c, l: c, c, v: null });
  }
  return out.sort((a, b) => a.t - b.t);
}

async function cboeBars(ctx: Ctx, symbol: string): Promise<Bar[]> {
  const f = CBOE_FILES[symbol];
  const text = await ctx.http.text(`https://cdn.cboe.com/api/global/us_indices/daily_prices/${f.file}_History.csv`, { source: CBOE, ttl: 1800 });
  const bars = parseCboeCsv(text, f.scale ?? 1);
  if (!bars.length) throw new SourceError(CBOE, `no rows for ${f.file}`);
  return bars;
}

// ---------------------------------------------------------------- crypto

const COINBASE = 'Coinbase';
const KRAKEN = 'Kraken';

/** Coinbase Exchange candles: [time s, low, high, open, close, volume], newest first. */
export function parseCoinbaseCandles(rows: unknown): Bar[] {
  if (!Array.isArray(rows)) return [];
  const out: Bar[] = [];
  for (const r of rows) {
    if (!Array.isArray(r) || r.length < 6) continue;
    const [ts, l, h, o, c, v] = r.map(Number);
    if ([ts, l, h, o, c].every(Number.isFinite)) out.push({ t: ts * 1000, o, h, l, c, v: Number.isFinite(v) ? v : null });
  }
  return out.sort((a, b) => a.t - b.t);
}

/** Kraken OHLC: { result: { PAIR: [[time s, o, h, l, c, vwap, volume, count], ...], last } }. */
export function parseKrakenOhlc(body: unknown): Bar[] {
  const b = body as { error?: string[]; result?: Record<string, unknown> };
  if (b.error?.length) throw new SourceError(KRAKEN, b.error.join('; '));
  const key = Object.keys(b.result ?? {}).find((k) => k !== 'last');
  const rows = key ? (b.result as Record<string, unknown>)[key] : undefined;
  if (!Array.isArray(rows)) return [];
  const out: Bar[] = [];
  for (const r of rows as unknown[][]) {
    const [ts, o, h, l, c, , v] = r.map(Number);
    if ([ts, o, h, l, c].every(Number.isFinite)) out.push({ t: ts * 1000, o, h, l, c, v: Number.isFinite(v) ? v : null });
  }
  return out.sort((a, b) => a.t - b.t);
}

function krakenPair(symbol: string): string {
  const [base, quote] = symbol.split('-');
  return `${base === 'BTC' ? 'XBT' : base}${quote}`;
}

async function coinbaseBars(ctx: Ctx, symbol: string, from: Date, to: Date): Promise<Bar[]> {
  const out: Bar[] = [];
  const first = Math.max(from.getTime(), Date.UTC(2015, 0, 1));
  // 300 candles per request; walk forward in 300-day windows (at most ~14 requests for MAX).
  for (let start = first; start <= to.getTime(); start += 300 * DAY) {
    const end = Math.min(start + 299 * DAY, to.getTime());
    const url = `https://api.exchange.coinbase.com/products/${encodeURIComponent(symbol)}/candles?granularity=86400&start=${new Date(start).toISOString()}&end=${new Date(end).toISOString()}`;
    const rows = await ctx.http.json<unknown>(url, { source: COINBASE, ttl: 1800 });
    out.push(...parseCoinbaseCandles(rows));
  }
  if (!out.length) throw new SourceError(COINBASE, `no candles for ${symbol}`);
  return out.sort((a, b) => a.t - b.t);
}

async function krakenBars(ctx: Ctx, symbol: string): Promise<Bar[]> {
  const body = await ctx.http.json<unknown>(`https://api.kraken.com/0/public/OHLC?pair=${krakenPair(symbol)}&interval=1440`, { source: KRAKEN, ttl: 1800 });
  const bars = parseKrakenOhlc(body);
  if (!bars.length) throw new SourceError(KRAKEN, `no candles for ${symbol}`);
  return bars;
}

// ---------------------------------------------------------------- currencies

const FRANKFURTER = 'ECB reference rates (Frankfurter)';

/** "EURUSD=X" -> EUR/USD; "JPY=X" -> USD/JPY. */
export function fxPair(symbol: string): { base: string; quote: string } | null {
  const s = symbol.trim().toUpperCase().replace(/=X$/, '');
  if (/^[A-Z]{6}$/.test(s)) return { base: s.slice(0, 3), quote: s.slice(3) };
  if (/^[A-Z]{3}$/.test(s)) return { base: 'USD', quote: s };
  return null;
}

/** Frankfurter time series: { rates: { "2026-11-23": { USD: 1.0939 }, ... } }. */
export function parseFrankfurterSeries(body: unknown, quote: string): Bar[] {
  const rates = (body as { rates?: Record<string, Record<string, number>> }).rates ?? {};
  const out: Bar[] = [];
  for (const [date, r] of Object.entries(rates)) {
    const t = Date.parse(`${date}T00:00:00Z`);
    const c = r?.[quote];
    if (!Number.isNaN(t) && typeof c === 'number' && Number.isFinite(c)) out.push({ t, o: c, h: c, l: c, c, v: null });
  }
  return out.sort((a, b) => a.t - b.t);
}

async function frankfurterBars(ctx: Ctx, symbol: string, from: Date): Promise<Bar[]> {
  const pair = fxPair(symbol);
  if (!pair) throw new SourceError(FRANKFURTER, `not a currency pair: ${symbol}`);
  const start = new Date(Math.max(from.getTime(), Date.UTC(1999, 0, 4))).toISOString().slice(0, 10);
  const body = await ctx.http.json<unknown>(`https://api.frankfurter.dev/v1/${start}..?base=${pair.base}&symbols=${pair.quote}`, { source: FRANKFURTER, ttl: 3600 });
  const bars = parseFrankfurterSeries(body, pair.quote);
  if (!bars.length) throw new SourceError(FRANKFURTER, `no rates for ${pair.base}/${pair.quote}`);
  return bars;
}

// ---------------------------------------------------------------- Canada (TMX)

const TMX = 'TMX Money';
const TMX_INDEX: Record<string, string> = { '^GSPTSE': '^TSX', '^TSX': '^TSX', '^TX60': '^TX60', '^JX': '^JX' };

/** RY.TO / SHOP.V -> the TMX symbol, a mapped Canadian index, or null when the symbol is not Canadian. */
export function tmxSymbol(symbol: string): string | null {
  const s = symbol.trim().toUpperCase();
  if (TMX_INDEX[s]) return TMX_INDEX[s];
  const m = /^([A-Z0-9]+(?:[-.][A-Z]{1,2})?)\.(TO|V)$/.exec(s);
  return m ? m[1].replace(/-/g, '.') : null;
}

interface TmxBar {
  datetime?: string;
  openPrice?: number | null;
  closePrice?: number | null;
  high?: number | null;
  low?: number | null;
  volume?: number | null;
}

/** TMX price history rows (newest first) to bars, oldest first. */
export function parseTmxHistory(rows: TmxBar[] | null | undefined): Bar[] {
  const out: Bar[] = [];
  for (const r of rows ?? []) {
    const t = Date.parse(`${(r.datetime ?? '').slice(0, 10)}T00:00:00Z`);
    const c = r.closePrice;
    if (Number.isNaN(t) || typeof c !== 'number' || !Number.isFinite(c)) continue;
    out.push({ t, o: r.openPrice ?? c, h: r.high ?? c, l: r.low ?? c, c, v: r.volume ?? null });
  }
  return out.sort((a, b) => a.t - b.t);
}

/** TMX Money GraphQL (the API behind money.tmx.com). */
export async function tmxQuery<T>(ctx: Ctx, operationName: string, query: string, variables: Record<string, unknown>, ttl = 300): Promise<T> {
  const body = await ctx.http.json<{ data?: T; errors?: { message?: string }[] }>('https://app-money.tmx.com/graphql', {
    source: TMX,
    ttl,
    method: 'POST',
    body: { operationName, variables, query },
  });
  if (!body.data) throw new SourceError(TMX, body.errors?.[0]?.message ?? 'no data');
  return body.data;
}

async function tmxBars(ctx: Ctx, tmx: string, from: Date, to: Date): Promise<Bar[]> {
  const data = await tmxQuery<{ getCompanyPriceHistoryForDownload?: TmxBar[] | null }>(
    ctx,
    'getCompanyPriceHistoryForDownload',
    'query getCompanyPriceHistoryForDownload($symbol: String!, $start: String, $end: String) { getCompanyPriceHistoryForDownload(symbol: $symbol, start: $start, end: $end) { datetime openPrice closePrice high low volume } }',
    { symbol: tmx, start: from.toISOString().slice(0, 10), end: to.toISOString().slice(0, 10) },
    1800,
  );
  const bars = parseTmxHistory(data.getCompanyPriceHistoryForDownload);
  if (!bars.length) throw new SourceError(TMX, `no history for ${tmx}`);
  return bars;
}

async function tmxQuote(ctx: Ctx, symbol: string, tmx: string): Promise<Quote> {
  const data = await tmxQuery<{ getQuoteBySymbol?: { name?: string; price?: number | null; priceChange?: number | null; percentChange?: number | null; prevClose?: number | null; exchangeName?: string } | null }>(
    ctx,
    'getQuoteBySymbol',
    'query getQuoteBySymbol($symbol: String, $locale: String) { getQuoteBySymbol(symbol: $symbol, locale: $locale) { symbol name price priceChange percentChange prevClose exchangeName } }',
    { symbol: tmx, locale: 'en' },
    60,
  );
  const q = data.getQuoteBySymbol;
  if (!q || typeof q.price !== 'number') throw new SourceError(TMX, `no quote for ${tmx}`);
  return { symbol, name: q.name, price: q.price, change: q.priceChange ?? null, changePct: q.percentChange ?? null, prevClose: q.prevClose ?? null, currency: 'CAD', exchange: q.exchangeName, source: TMX };
}

// ---------------------------------------------------------------- Yahoo (secondary)

/** After Yahoo refuses once, skip it for a while instead of hammering a blocked host on every symbol. */
let yahooBlockedUntil = 0;
let yahooBlockedWhy = '';

async function yahoo(ctx: Ctx, symbol: string, from: Date, to: Date): Promise<Awaited<ReturnType<typeof yahooChart>>> {
  if (Date.now() < yahooBlockedUntil) throw new SourceError(YAHOO, yahooBlockedWhy);
  try {
    return await yahooChart(ctx, symbol, from, to);
  } catch (e) {
    const status = e instanceof SourceError ? e.status : undefined;
    if (status === 429 || status === 403 || status === 401) {
      yahooBlockedUntil = Date.now() + 5 * 60_000;
      yahooBlockedWhy = `refused this network (HTTP ${status})`;
    }
    throw e;
  }
}

// ---------------------------------------------------------------- history

/** Dot + exchange code means a listing outside the U.S. (RY.TO, 7203.T); BRK.A / BRK.B style class shares stay U.S. */
function isUsListing(symbol: string): boolean {
  const s = symbol.toUpperCase();
  const dot = s.lastIndexOf('.');
  if (dot < 0) return true;
  return /^[A-Z]+$/.test(s.slice(0, dot)) && /^[AB]$/.test(s.slice(dot + 1));
}

async function historyFrom(ctx: Ctx, rawSymbol: string, from: Date): Promise<History> {
  const symbol = rawSymbol.trim().toUpperCase();
  const to = ctx.now();
  const cut = (bars: Bar[]): Bar[] => bars.filter((b) => b.t >= from.getTime());
  const viaYahoo = { name: YAHOO, run: async () => ({ bars: cut((await yahoo(ctx, symbol, from, to)).bars) }) };
  const cls = classify(symbol);
  const chain: { name: string; run: () => Promise<{ bars: Bar[] }> }[] = [];

  const tmx = cls === 'index' || cls === 'stock' ? tmxSymbol(symbol) : null;
  if (tmx) {
    chain.push({ name: TMX, run: async () => ({ bars: await tmxBars(ctx, tmx, from.getTime() <= 0 ? new Date(Date.UTC(to.getUTCFullYear() - 20, 0, 1)) : from, to) }) });
  } else if (cls === 'index') {
    if (CBOE_FILES[symbol]) chain.push({ name: CBOE, run: async () => ({ bars: cut(await cboeBars(ctx, symbol)) }) });
    else {
      const code = NASDAQ_INDEX[symbol] ?? symbol.slice(1);
      chain.push({
        name: NASDAQ,
        run: async () => {
          const bars = await nasdaqHistory(ctx, code, 'index', nasdaqFloor(from, to), to);
          // Some indices Nasdaq quotes have no maintained history: the file repeats one close with zeroed OHLC.
          if (bars.length > 3 && bars.slice(-3).every((b) => b.o === 0 && b.h === 0)) throw new SourceError(NASDAQ, `history for ${code} is not maintained`);
          return { bars };
        },
      });
    }
  } else if (cls === 'crypto') {
    chain.push({ name: COINBASE, run: async () => ({ bars: cut(await coinbaseBars(ctx, symbol, from, to)) }) });
    chain.push({ name: KRAKEN, run: async () => ({ bars: cut(await krakenBars(ctx, symbol)) }) });
  } else if (cls === 'fx') {
    chain.push({ name: FRANKFURTER, run: async () => ({ bars: cut(await frankfurterBars(ctx, symbol, from)) }) });
  } else if (cls === 'future' && cdeCovers(symbol)) {
    chain.push({ name: CDE, run: async () => ({ bars: cut((await cdeBars(ctx, symbol, from, to)).bars) }) });
  } else if (cls === 'stock' && isUsListing(symbol)) {
    chain.push({
      name: NASDAQ,
      run: async () => ({ bars: await nasdaqHistoryAuto(ctx, symbol, nasdaqFloor(from, to), to) }),
    });
    chain.push({ name: NICHEDB, run: async () => ({ bars: cut(await nichedbBars(ctx, symbol)) }) });
  }
  chain.push(viaYahoo);

  const got = await firstOf(chain.map((p) => ({
    name: p.name,
    run: async () => {
      const r = await p.run();
      if (!r.bars.length) throw new SourceError(p.name, `no history for ${symbol}`);
      return r;
    },
  })));
  return { symbol, bars: got.value.bars, source: got.source, currency: cls === 'fx' ? fxPair(symbol)?.quote : undefined };
}

/** Nasdaq serves about ten years; asking for more returns nothing, so clamp. */
function nasdaqFloor(from: Date, to: Date): Date {
  const floor = new Date(Date.UTC(to.getUTCFullYear() - 10, to.getUTCMonth(), to.getUTCDate() + 1));
  return from.getTime() < floor.getTime() ? floor : from;
}

/**
 * Daily bars, oldest first. Throws when no provider has history for the symbol.
 * A few days before the range start are included so a return over the full
 * range always has a starting bar.
 */
export async function getHistory(ctx: Ctx, symbol: string, range: Range): Promise<History> {
  const start = rangeStart(range, ctx.now());
  return historyFrom(ctx, symbol, range === 'MAX' ? start : new Date(start.getTime() - 7 * DAY));
}

// ---------------------------------------------------------------- quotes

function fromBars(symbol: string, bars: Bar[], source: string, name?: string, currency?: string): Quote {
  const last = bars[bars.length - 1];
  const prev = bars.length > 1 ? bars[bars.length - 2] : undefined;
  return {
    symbol,
    name,
    price: last.c,
    change: prev ? last.c - prev.c : null,
    changePct: prev ? pctChange(last.c, prev.c) : null,
    prevClose: prev?.c ?? null,
    currency,
    time: new Date(last.t).toISOString().slice(0, 10),
    source,
  };
}

function fromNasdaq(symbol: string, info: NasdaqInfo): Quote {
  const t = parseTrade(info.primaryData);
  if (t.price === null) throw new SourceError(NASDAQ, `no price for ${symbol}`);
  // Before the open the first block can carry no change; the second block is then the prior close.
  if (t.change === null) {
    const close = parseTrade(info.secondaryData).price;
    if (close !== null) {
      t.prevClose = close;
      t.change = t.price - close;
      t.changePct = pctChange(t.price, close);
    }
  }
  return {
    symbol,
    name: info.companyName,
    price: t.price,
    change: t.change,
    changePct: t.changePct,
    prevClose: t.prevClose,
    currency: 'USD',
    exchange: info.exchange ?? undefined,
    time: t.time,
    source: NASDAQ,
  };
}

async function yahooQuote(ctx: Ctx, symbol: string): Promise<Quote> {
  const now = ctx.now();
  const y = await yahoo(ctx, symbol, new Date(now.getTime() - 10 * DAY), now);
  if (y.price === null) throw new SourceError(YAHOO, `no price for ${symbol}`);
  return {
    symbol,
    name: y.name,
    price: y.price,
    change: y.prevClose !== null ? y.price - y.prevClose : null,
    changePct: pctChange(y.price, y.prevClose),
    prevClose: y.prevClose,
    currency: y.currency,
    exchange: y.exchange,
    time: y.time,
    source: YAHOO,
  };
}

/** Throws when no provider can price the symbol. */
export async function getQuote(ctx: Ctx, rawSymbol: string): Promise<Quote> {
  const symbol = rawSymbol.trim().toUpperCase();
  const cls = classify(symbol);
  const now = ctx.now();
  const recent = new Date(now.getTime() - 14 * DAY);
  const chain: { name: string; run: () => Promise<Quote> }[] = [];

  const tmx = cls === 'index' || cls === 'stock' ? tmxSymbol(symbol) : null;
  if (tmx) {
    chain.push({ name: TMX, run: () => tmxQuote(ctx, symbol, tmx) });
  } else if (cls === 'index') {
    const f = CBOE_FILES[symbol];
    if (f) chain.push({ name: CBOE, run: async () => fromBars(symbol, await cboeBars(ctx, symbol), CBOE, f.name) });
    else {
      const code = NASDAQ_INDEX[symbol] ?? symbol.slice(1);
      chain.push({ name: NASDAQ, run: async () => ({ ...fromNasdaq(symbol, (await nasdaqInfo(ctx, code, 'index')).info), currency: undefined }) });
    }
  } else if (cls === 'crypto') {
    chain.push({
      name: COINBASE,
      run: async () => {
        const s = await ctx.http.json<{ open?: string; last?: string }>(`https://api.exchange.coinbase.com/products/${encodeURIComponent(symbol)}/stats`, { source: COINBASE, ttl: 60 });
        const price = Number(s.last);
        const open = Number(s.open);
        if (!Number.isFinite(price) || price <= 0) throw new SourceError(COINBASE, `no price for ${symbol}`);
        const ok = Number.isFinite(open) && open > 0;
        // Coinbase reports a rolling 24-hour open, so the change is over 24 hours.
        return { symbol, price, change: ok ? price - open : null, changePct: ok ? pctChange(price, open) : null, prevClose: ok ? open : null, currency: symbol.split('-')[1], time: now.toISOString(), source: COINBASE };
      },
    });
    chain.push({ name: KRAKEN, run: async () => fromBars(symbol, await krakenBars(ctx, symbol), KRAKEN, undefined, symbol.split('-')[1]) });
  } else if (cls === 'fx') {
    chain.push({ name: FRANKFURTER, run: async () => fromBars(symbol, await frankfurterBars(ctx, symbol, recent), FRANKFURTER, undefined, fxPair(symbol)?.quote) });
  } else if (cls === 'future' && cdeCovers(symbol)) {
    chain.push({
      name: CDE,
      run: async () => {
        const c = await cdeContract(ctx, symbol);
        const price = c.price as number;
        // Coinbase reports the move over 24 hours, not from a daily settlement.
        const prev = c.changePct !== null && c.changePct > -100 ? price / (1 + c.changePct / 100) : null;
        return { symbol, name: c.name, price, change: prev !== null ? price - prev : null, changePct: c.changePct, prevClose: prev, currency: 'USD', exchange: CDE, time: now.toISOString(), source: CDE };
      },
    });
  } else if (cls === 'stock' && isUsListing(symbol)) {
    chain.push({ name: NASDAQ, run: async () => fromNasdaq(symbol, (await nasdaqInfo(ctx, symbol)).info) });
    chain.push({ name: NICHEDB, run: async () => fromBars(symbol, await nichedbBars(ctx, symbol), NICHEDB, undefined, 'USD') });
  }
  chain.push({ name: YAHOO, run: () => yahooQuote(ctx, symbol) });
  return (await firstOf(chain)).value;
}

/** Run `fn` over `items` with at most `limit` in flight; results keep the input order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

function reason(e: unknown): string {
  return e instanceof Error ? e.message : 'unavailable';
}

/** Never throws: a symbol nobody can price comes back with `price: null`. Same order as `symbols`. */
export async function getQuotes(ctx: Ctx, symbols: string[]): Promise<Quote[]> {
  return mapLimit(symbols, 4, async (symbol) => {
    try {
      return await getQuote(ctx, symbol);
    } catch (e) {
      return { symbol: symbol.trim().toUpperCase(), price: null, change: null, changePct: null, source: reason(e) };
    }
  });
}

// ---------------------------------------------------------------- returns board

/** Close of the last bar on or before `t`, or null when the history starts later. */
export function closeOnOrBefore(bars: Bar[], t: number): number | null {
  let lo = 0;
  let hi = bars.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].t <= t) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found < 0 ? null : bars[found].c;
}

export interface Returns {
  last: number | null;
  asOf: number | null;
  day: number | null;
  w1: number | null;
  m1: number | null;
  m3: number | null;
  ytd: number | null;
  y1: number | null;
}

/** Percent returns to the last bar, each measured from the close on or before the horizon date. */
export function computeReturns(bars: Bar[]): Returns {
  if (!bars.length) return { last: null, asOf: null, day: null, w1: null, m1: null, m3: null, ytd: null, y1: null };
  const end = bars[bars.length - 1];
  const d = new Date(end.t);
  const back = (months: number): number => {
    const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - months + 1, 0)).getUTCDate();
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - months, Math.min(d.getUTCDate(), lastDay));
  };
  const ret = (t: number): number | null => pctChange(end.c, closeOnOrBefore(bars, t));
  return {
    last: end.c,
    asOf: end.t,
    day: bars.length > 1 ? pctChange(end.c, bars[bars.length - 2].c) : null,
    w1: ret(end.t - 7 * DAY),
    m1: ret(back(1)),
    m3: ret(back(3)),
    ytd: ret(Date.UTC(d.getUTCFullYear(), 0, 0)),
    y1: ret(back(12)),
  };
}

/**
 * A quote board: last price, day change and return over five horizons
 * (1W, 1M, 3M, YTD, 1Y) for each symbol. `source` names the providers used.
 */
export async function returnsBoard(
  ctx: Ctx,
  items: { symbol: string; label?: string }[],
  title?: string,
): Promise<{ block: TableBlock; source: string; notes: string[] }> {
  const got = await mapLimit(items, 6, async (it) => {
    try {
      return { ok: true as const, h: await getHistory(ctx, it.symbol, '1Y') };
    } catch (e) {
      return { ok: false as const, why: reason(e) };
    }
  });
  const sources: string[] = [];
  const failed = new Map<string, string[]>();
  let asOf = 0;
  const rows: Row[] = items.map((it, i) => {
    const g = got[i];
    const label = it.label ?? it.symbol;
    if (!g.ok) {
      failed.set(g.why, [...(failed.get(g.why) ?? []), it.symbol]);
      return { name: label, symbol: it.symbol };
    }
    if (!sources.includes(g.h.source)) sources.push(g.h.source);
    const r = computeReturns(g.h.bars);
    if (r.asOf && r.asOf > asOf) asOf = r.asOf;
    return { name: label, symbol: it.symbol, last: r.last, day: r.day, w1: r.w1, m1: r.m1, m3: r.m3, ytd: r.ytd, y1: r.y1 };
  });
  // One entry per reason, so a blocked provider is named once rather than once per symbol.
  const failures = [...failed.entries()].map(([why, syms]) => `${syms.join(', ')} (${why.replace(/rate limited \(HTTP 429\)/, 'refused this network (HTTP 429)')})`);
  if (!sources.length) throw new SourceError('Market data', `no provider answered: ${failures.join('; ')}`);
  const notes = [
    `Price return from daily closes${asOf ? ` through ${new Date(asOf).toISOString().slice(0, 10)}` : ''}: split-adjusted, dividends and coupons not included. Last is the latest daily close, not a live quote.`,
  ];
  if (failures.length) notes.push(`No data for: ${failures.join('; ')}`);
  return {
    block: {
      kind: 'table',
      title,
      columns: [
        { key: 'name', label: 'Name', maxWidth: 30 },
        { key: 'symbol', label: 'Symbol' },
        { key: 'last', label: 'Last', format: 'num' },
        { key: 'day', label: 'Day', format: 'signedPct' },
        { key: 'w1', label: '1W', format: 'signedPct' },
        { key: 'm1', label: '1M', format: 'signedPct' },
        { key: 'm3', label: '3M', format: 'signedPct' },
        { key: 'ytd', label: 'YTD', format: 'signedPct' },
        { key: 'y1', label: '1Y', format: 'signedPct' },
      ],
      rows,
    },
    source: sources.join(', '),
    notes,
  };
}

