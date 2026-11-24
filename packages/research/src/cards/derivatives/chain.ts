/**
 * Option chains from public sources, normalised to one shape and enriched
 * with implied volatility and Greeks computed here.
 *
 * Routing by symbol:
 *   BTC, ETH (also BTC-USD, ETH-USD)  Deribit
 *   XYZ.TO                            Montreal Exchange (TMX)
 *   anything else                     Nasdaq public API, then Cboe delayed quotes
 */
import { firstOf, num } from '../../http.js';
import { SourceError, type Ctx } from '../../types.js';
import { greeks, impliedVol, type Model, type OptionType } from './optionmath.js';
import { deribitRawChain } from './deribit.js';

export interface RawQuote {
  expiry: string;
  strike: number;
  type: OptionType;
  bid: number | null;
  ask: number | null;
  last: number | null;
  volume: number | null;
  oi: number | null;
  /** Implied vol published by the venue (decimal), when it gives one. */
  ivGiven?: number | null;
  /** Per-contract underlying (the forward for the expiry) when the venue quotes against one. */
  underlying?: number | null;
}

export interface OptionQuote extends RawQuote {
  mid: number | null;
  /** Decimal (0.25 = 25%). */
  iv: number | null;
  delta: number | null;
  gamma: number | null;
  vega: number | null;
  theta: number | null;
}

export interface RawChain {
  symbol: string;
  spot: number;
  /** ISO date or datetime of the quotes. */
  asOf?: string;
  source: string;
  sourceUrl?: string;
  quotes: RawQuote[];
  /** Units of underlying per contract: 100 for listed equity options, 1 on Deribit. */
  multiplier: number;
  currency: string;
  model: Model;
  /** Trading days per year for realised volatility of the underlying. */
  periods: number;
  /** Use the venue's implied vol in preference to solving from the mid price. */
  preferGivenIv?: boolean;
  /** Hour (UTC) at which contracts expire. */
  expiryHourUtc: number;
  notes: string[];
}

export interface Chain extends Omit<RawChain, 'quotes'> {
  quotes: OptionQuote[];
  /** Sorted YYYY-MM-DD. */
  expiries: string[];
  /** Risk-free rate used, decimal. */
  rate: number;
  rateLabel: string;
  /** Parity-implied forward by expiry used for pricing spot-quoted chains (empty on Deribit). */
  forwards: Record<string, number>;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** "December 18, 2026" or "NOV 24, 2026" to 2026-12-18. Null when it does not parse. */
export function parseLongDate(text: string): string | null {
  const m = /([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),\s*(\d{4})/.exec(text);
  if (!m) return null;
  const month = MONTHS.indexOf(m[1].toLowerCase());
  if (month < 0) return null;
  return `${m[3]}-${String(month + 1).padStart(2, '0')}-${m[2].padStart(2, '0')}`;
}

// ---------------------------------------------------------------- Nasdaq

interface NasdaqRow {
  expirygroup?: string | null;
  strike?: string | null;
  [k: string]: string | boolean | null | undefined;
}

export interface NasdaqChainBody {
  data?: {
    totalRecord?: number;
    lastTrade?: string | null;
    table?: { rows?: NasdaqRow[] | null } | null;
  } | null;
  status?: { rCode?: number; bCodeMessage?: { errorMessage?: string }[] | null } | null;
}

/**
 * Nasdaq option-chain response to quotes. Rows come grouped: a header row
 * carries the full expiry date in `expirygroup`, and the rows that follow
 * belong to it. Each row holds the call and the put for one strike.
 */
export function parseNasdaqChain(body: NasdaqChainBody): { spot: number | null; asOf?: string; quotes: RawQuote[] } {
  const rows = body.data?.table?.rows ?? [];
  const lastTrade = body.data?.lastTrade ?? '';
  const spot = num(/\$\s*([\d,]+\.?\d*)/.exec(lastTrade)?.[1] ?? null);
  const asOf = parseLongDate(lastTrade) ?? undefined;
  const quotes: RawQuote[] = [];
  let expiry: string | null = null;
  for (const r of rows) {
    if (r.expirygroup) {
      expiry = parseLongDate(String(r.expirygroup));
      continue;
    }
    const strike = num(r.strike);
    if (!expiry || strike === null) continue;
    for (const [side, type] of [['c', 'C'], ['p', 'P']] as const) {
      quotes.push({
        expiry,
        strike,
        type,
        bid: num(r[`${side}_Bid`]),
        ask: num(r[`${side}_Ask`]),
        last: num(r[`${side}_Last`]),
        volume: num(r[`${side}_Volume`]),
        oi: num(r[`${side}_Openinterest`]),
      });
    }
  }
  return { spot, asOf, quotes };
}

async function nasdaqChain(ctx: Ctx, symbol: string): Promise<RawChain> {
  const source = 'Nasdaq';
  const sym = symbol.replace('-', '.');
  let lastError = 'no option chain';
  for (const assetclass of ['stocks', 'etf']) {
    const url = `https://api.nasdaq.com/api/quote/${encodeURIComponent(sym)}/option-chain?assetclass=${assetclass}&limit=30000&fromdate=all&todate=undefined&excode=oprac&callput=callput&money=all&type=all`;
    const body = await ctx.http.json<NasdaqChainBody>(url, { source, ttl: 300, timeoutMs: 40_000 });
    const parsed = parseNasdaqChain(body);
    if (parsed.quotes.length && parsed.spot !== null) {
      return {
        symbol,
        spot: parsed.spot,
        asOf: parsed.asOf,
        source,
        sourceUrl: `https://www.nasdaq.com/market-activity/${assetclass}/${sym.toLowerCase()}/option-chain`,
        quotes: parsed.quotes,
        multiplier: 100,
        currency: 'USD',
        model: 'bs',
        periods: 252,
        expiryHourUtc: 21,
        notes: ['Quotes are delayed composite (OPRA) quotes; outside U.S. market hours they are the last session\'s.'],
      };
    }
    lastError = body.status?.bCodeMessage?.[0]?.errorMessage ?? lastError;
  }
  throw new SourceError(source, `${symbol}: ${lastError}`);
}

// ---------------------------------------------------------------- Cboe

export interface CboeChainBody {
  timestamp?: string;
  data?: {
    current_price?: number | null;
    close?: number | null;
    options?: {
      option?: string;
      bid?: number | null;
      ask?: number | null;
      iv?: number | null;
      open_interest?: number | null;
      volume?: number | null;
      last_trade_price?: number | null;
    }[];
  };
}

/** OCC option symbol ("AAPL261218C00150000") to its parts. */
export function parseOccSymbol(s: string): { root: string; expiry: string; type: OptionType; strike: number } | null {
  const m = /^([A-Z0-9.]+?)\s*(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/.exec(s.trim());
  if (!m) return null;
  return { root: m[1], expiry: `20${m[2]}-${m[3]}-${m[4]}`, type: m[5] as OptionType, strike: Number(m[6]) / 1000 };
}

/** Cboe delayed-quote JSON (`cdn.cboe.com/api/global/delayed_quotes/options/{SYM}.json`) to quotes. */
export function parseCboeChain(body: CboeChainBody): { spot: number | null; asOf?: string; quotes: RawQuote[] } {
  const quotes: RawQuote[] = [];
  for (const o of body.data?.options ?? []) {
    const id = parseOccSymbol(o.option ?? '');
    if (!id) continue;
    const pos = (v: number | null | undefined): number | null => (typeof v === 'number' && v > 0 ? v : null);
    quotes.push({
      expiry: id.expiry,
      strike: id.strike,
      type: id.type,
      bid: pos(o.bid),
      ask: pos(o.ask),
      last: pos(o.last_trade_price),
      volume: num(o.volume),
      oi: num(o.open_interest),
      ivGiven: pos(o.iv),
    });
  }
  const spot = num(body.data?.current_price) ?? num(body.data?.close);
  return { spot, asOf: body.timestamp ? body.timestamp.replace(' ', 'T').slice(0, 19) : undefined, quotes };
}

async function cboeChain(ctx: Ctx, symbol: string): Promise<RawChain> {
  const source = 'Cboe';
  const sym = symbol.replace(/^\^/, '_').replace('-', '.');
  const body = await ctx.http.json<CboeChainBody>(`https://cdn.cboe.com/api/global/delayed_quotes/options/${encodeURIComponent(sym)}.json`, { source, ttl: 300 });
  const parsed = parseCboeChain(body);
  if (!parsed.quotes.length || parsed.spot === null) throw new SourceError(source, `${symbol}: no option chain`);
  return {
    symbol,
    spot: parsed.spot,
    asOf: parsed.asOf,
    source,
    sourceUrl: `https://www.cboe.com/delayed_quotes/${sym.toLowerCase()}/quote_table`,
    quotes: parsed.quotes,
    multiplier: 100,
    currency: 'USD',
    model: 'bs',
    periods: 252,
    expiryHourUtc: 21,
    notes: ['Quotes are delayed about 15 minutes.'],
  };
}

// ---------------------------------------------------------------- Montreal Exchange

interface TmxSide {
  expiry_date?: string;
  strike_price?: number;
  last_price?: number;
  volume?: number;
  bid_price?: number;
  ask_price?: number;
  open_interest?: number;
  volatility?: number;
  is_option?: number;
}

function unescapeHtml(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/**
 * Montreal Exchange quote page to quotes. Each table row carries the call
 * and put for a strike as JSON in its `data-row` attribute. The underlying's
 * last price is in the quote header; before the open it reads 0, in which
 * case the midpoint of the underlying's bid and ask is used.
 */
export function parseTmxPage(html: string): { spot: number | null; asOf?: string; quotes: RawQuote[] } {
  const quotes: RawQuote[] = [];
  const re = /data-row='([^']+)'/g;
  let m: RegExpExecArray | null;
  const pos = (v: number | undefined): number | null => (typeof v === 'number' && v > 0 ? v : null);
  while ((m = re.exec(html))) {
    let row: { call?: TmxSide; put?: TmxSide };
    try {
      row = JSON.parse(unescapeHtml(m[1])) as { call?: TmxSide; put?: TmxSide };
    } catch {
      continue;
    }
    for (const [side, type] of [[row.call, 'C'], [row.put, 'P']] as const) {
      if (!side || side.is_option === 0 || !side.expiry_date || !(typeof side.strike_price === 'number')) continue;
      quotes.push({
        expiry: side.expiry_date,
        strike: side.strike_price,
        type,
        bid: pos(side.bid_price),
        ask: pos(side.ask_price),
        last: pos(side.last_price),
        volume: num(side.volume),
        oi: num(side.open_interest),
        ivGiven: pos(side.volatility) !== null ? (side.volatility as number) / 100 : null,
      });
    }
  }
  const head = unescapeHtml(html.slice(0, html.indexOf('<table') > 0 ? html.indexOf('<table') : html.length));
  const field = (label: string): number | null => num(new RegExp(`${label}:\\s*<b[^>]*>([^<]+)</b>`, 'i').exec(head)?.[1] ?? null);
  const last = field('Last price');
  const bid = field('Bid price');
  const ask = field('Ask price');
  const spot = last && last > 0 ? last : bid && ask && bid > 0 && ask > 0 ? (bid + ask) / 2 : null;
  const asOf = parseLongDate(/Last update:\s*<b>([^<]+)<\/b>/i.exec(head)?.[1] ?? '') ?? undefined;
  return { spot, asOf, quotes };
}

async function tmxChain(ctx: Ctx, symbol: string): Promise<RawChain> {
  const source = 'Montreal Exchange';
  const root = symbol.replace(/\.TO$/i, '').replace(/[-.]/g, '.').toUpperCase();
  const url = `https://www.m-x.ca/en/trading/data/quotes?symbol=${encodeURIComponent(root)}`;
  const html = await ctx.http.text(url, { source, ttl: 300, timeoutMs: 30_000 });
  const parsed = parseTmxPage(html);
  if (!parsed.quotes.length) throw new SourceError(source, `${symbol}: no options listed`);
  if (parsed.spot === null) throw new SourceError(source, `${symbol}: no underlying price on the quote page`);
  return {
    symbol,
    spot: parsed.spot,
    asOf: parsed.asOf,
    source,
    sourceUrl: url,
    quotes: parsed.quotes,
    multiplier: 100,
    currency: 'CAD',
    model: 'bs',
    periods: 252,
    expiryHourUtc: 21,
    notes: ['Where a contract has no two-sided quote, the implied volatility is the exchange\'s own figure.'],
  };
}

// ---------------------------------------------------------------- risk-free rate

interface RefRates {
  refRates?: { effectiveDate?: string; percentRate?: number }[];
}

/** Overnight risk-free rate for the chain's currency: SOFR (EFFR as substitute) for USD, CORRA for CAD. */
export async function riskFreeRate(ctx: Ctx, currency: string): Promise<{ rate: number; label: string }> {
  if (currency === 'CAD') {
    const body = await ctx.http.json<{ observations?: { d?: string; 'AVG.INTWO'?: { v?: string } }[] }>(
      'https://www.bankofcanada.ca/valet/observations/AVG.INTWO/json?recent=1',
      { source: 'Bank of Canada', ttl: 21600 },
    );
    const o = body.observations?.[0];
    const v = num(o?.['AVG.INTWO']?.v ?? null);
    if (v === null) throw new SourceError('Bank of Canada', 'no CORRA observation');
    return { rate: v / 100, label: `CORRA ${v.toFixed(2)}% (Bank of Canada, ${o?.d ?? ''})` };
  }
  const nyfed = (path: string, name: string) => async (): Promise<{ rate: number; label: string }> => {
    const body = await ctx.http.json<RefRates>(`https://markets.newyorkfed.org/api/rates/${path}/last/1.json`, { source: 'New York Fed', ttl: 21600 });
    const r = body.refRates?.[0];
    if (typeof r?.percentRate !== 'number') throw new SourceError('New York Fed', `no ${name} rate`);
    return { rate: r.percentRate / 100, label: `${name} ${r.percentRate.toFixed(2)}% (New York Fed, ${r.effectiveDate ?? ''})` };
  };
  const got = await firstOf([
    { name: 'SOFR', run: nyfed('secured/sofr', 'SOFR') },
    { name: 'EFFR', run: nyfed('unsecured/effr', 'EFFR') },
  ]);
  return got.value;
}

// ---------------------------------------------------------------- enrichment

const YEAR_MS = 365 * 86_400_000;

/** Years from `now` to the expiry moment. Zero or negative once expired. */
export function yearsTo(expiry: string, now: Date, hourUtc: number): number {
  const t = Date.parse(`${expiry}T${String(hourUtc).padStart(2, '0')}:00:00Z`);
  return (t - now.getTime()) / YEAR_MS;
}

export function daysTo(expiry: string, now: Date): number {
  return Math.max(0, Math.round((Date.parse(`${expiry}T00:00:00Z`) - Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())) / 86_400_000));
}

/** Midpoint of a two-sided quote; null unless both sides are positive and not crossed. */
export function midPrice(bid: number | null, ask: number | null): number | null {
  if (bid === null || ask === null || !(bid > 0) || !(ask > 0) || ask < bid) return null;
  return (bid + ask) / 2;
}

/**
 * A midpoint good enough to solve an implied vol from. A market whose ask is
 * more than three times its bid (and more than a quarter-point wide) says
 * little about value, and its midpoint would print a spurious volatility.
 */
export function usableMid(bid: number | null, ask: number | null): number | null {
  const mid = midPrice(bid, ask);
  if (mid === null || bid === null || ask === null) return null;
  if (ask > 3 * bid && ask - bid > 0.25) return null;
  return mid;
}

/**
 * Forward price for each expiry implied by put-call parity at the strike
 * nearest spot with a two-sided call and put: F = K + e^(rT) (C - P).
 * Pricing against it absorbs dividends and an underlying print that is out
 * of step with the option quotes. An expiry whose parity forward is more
 * than 10% from spot (a broken quote) is left out.
 */
export function impliedForwards(raw: Pick<RawChain, 'quotes' | 'spot' | 'expiryHourUtc'>, rate: number, now: Date): Record<string, number> {
  const mids = new Map<string, Map<number, { C?: number; P?: number }>>();
  for (const q of raw.quotes) {
    const mid = usableMid(q.bid, q.ask);
    if (mid === null) continue;
    const byStrike = mids.get(q.expiry) ?? new Map<number, { C?: number; P?: number }>();
    byStrike.set(q.strike, { ...byStrike.get(q.strike), [q.type]: mid });
    mids.set(q.expiry, byStrike);
  }
  const out: Record<string, number> = {};
  for (const [expiry, byStrike] of mids) {
    const T = yearsTo(expiry, now, raw.expiryHourUtc);
    if (!(T > 0)) continue;
    const pairs = [...byStrike.entries()].filter(([, v]) => v.C !== undefined && v.P !== undefined);
    if (!pairs.length) continue;
    pairs.sort((x, y) => Math.abs(x[0] - raw.spot) - Math.abs(y[0] - raw.spot));
    const [K, v] = pairs[0];
    const F = K + Math.exp(rate * T) * ((v.C as number) - (v.P as number));
    if (F > 0 && Math.abs(F / raw.spot - 1) <= 0.1) out[expiry] = F;
  }
  return out;
}

/**
 * Add mid, implied vol and Greeks to raw quotes. Expired contracts are
 * dropped. Spot-quoted chains (model 'bs') are priced with Black-76 on each
 * expiry's parity-implied forward when one can be derived, and delta and
 * gamma are converted back to spot terms.
 */
export function enrichChain(raw: RawChain, rate: number, rateLabel: string, now: Date): Chain {
  const quotes: OptionQuote[] = [];
  const forwards = raw.model === 'bs' ? impliedForwards(raw, rate, now) : {};
  for (const q of raw.quotes) {
    const T = yearsTo(q.expiry, now, raw.expiryHourUtc);
    if (!(T > 0)) continue;
    const F = q.underlying == null ? forwards[q.expiry] : undefined;
    const model: Model = F === undefined ? raw.model : 'black76';
    const S = F ?? q.underlying ?? raw.spot;
    const mid = midPrice(q.bid, q.ask);
    const base = { type: q.type, S, K: q.strike, T, r: rate };
    const fair = usableMid(q.bid, q.ask);
    const solved = fair !== null ? impliedVol(fair, base, model) : null;
    const given = q.ivGiven ?? null;
    const iv = raw.preferGivenIv ? given ?? solved : solved ?? given;
    const g = iv !== null ? greeks({ ...base, sigma: iv }, model) : null;
    // dF/dS = F/S, so spot delta = forward delta x F/S and spot gamma = forward gamma x (F/S)^2.
    const k = F === undefined ? 1 : F / raw.spot;
    quotes.push({ ...q, mid, iv, delta: g ? g.delta * k : null, gamma: g ? g.gamma * k * k : null, vega: g?.vega ?? null, theta: g?.theta ?? null });
  }
  const expiries = [...new Set(quotes.map((q) => q.expiry))].sort();
  return { ...raw, notes: [...raw.notes], quotes, expiries, rate, rateLabel, forwards };
}

/** BTC, ETH, BTC-USD, ETHUSD ... to a Deribit currency; null for anything else. */
export function cryptoCurrency(symbol: string): 'BTC' | 'ETH' | null {
  const m = /^(BTC|ETH|XBT)(-?(USD|USDT|USDC|PERPETUAL))?$/i.exec(symbol.trim());
  if (!m) return null;
  return m[1].toUpperCase() === 'ETH' ? 'ETH' : 'BTC';
}

export async function loadChain(ctx: Ctx, symbolIn: string): Promise<Chain> {
  const symbol = symbolIn.trim().toUpperCase();
  if (!symbol) throw new SourceError('Options', 'no symbol given');
  const now = ctx.now();
  const coin = cryptoCurrency(symbol);
  if (coin) {
    const raw = await deribitRawChain(ctx, coin);
    return enrichChain(raw, 0, 'none (options on a forward, Black-76 with zero discounting)', now);
  }
  if (/\.TO$/.test(symbol)) {
    const raw = await tmxChain(ctx, symbol);
    const rf = await riskFreeRate(ctx, 'CAD');
    return enrichChain(raw, rf.rate, rf.label, now);
  }
  let raw: RawChain;
  const skipped: string[] = [];
  try {
    raw = await nasdaqChain(ctx, symbol);
  } catch (first) {
    try {
      raw = await cboeChain(ctx, symbol);
    } catch (second) {
      // Report both: the first provider's reason (an unknown symbol) is usually the useful one.
      throw new SourceError('Options', `no chain for ${symbol}. ${(first as Error).message}; ${(second as Error).message}`);
    }
    skipped.push(`Nasdaq unavailable (${(first as Error).message.replace(/^[^:]+:\s*/, '')})`);
  }
  const rf = await riskFreeRate(ctx, 'USD');
  const chain = enrichChain(raw, rf.rate, rf.label, now);
  chain.notes.push(...skipped);
  return chain;
}

// ---------------------------------------------------------------- selection helpers

/** Standard monthly expiry: the third Friday, or the Thursday before it when that Friday is a holiday. */
export function isThirdFriday(expiry: string): boolean {
  const d = new Date(`${expiry}T00:00:00Z`);
  const day = d.getUTCDate();
  const dow = d.getUTCDay();
  return (dow === 5 && day >= 15 && day <= 21) || (dow === 4 && day >= 14 && day <= 20);
}

/** Deribit monthlies expire on the last Friday of the month. */
export function isLastFriday(expiry: string): boolean {
  const d = new Date(`${expiry}T00:00:00Z`);
  if (d.getUTCDay() !== 5) return false;
  return new Date(d.getTime() + 7 * 86_400_000).getUTCMonth() !== d.getUTCMonth();
}

export function monthlyExpiries(chain: Pick<Chain, 'expiries' | 'multiplier'>): string[] {
  const set = new Set(chain.expiries);
  if (chain.multiplier === 1) return chain.expiries.filter(isLastFriday);
  return chain.expiries.filter((e) => {
    if (!isThirdFriday(e)) return false;
    // A Thursday only counts when the Friday after it is not listed.
    const d = new Date(`${e}T00:00:00Z`);
    if (d.getUTCDay() === 4) return !set.has(new Date(d.getTime() + 86_400_000).toISOString().slice(0, 10));
    return true;
  });
}

/**
 * The expiry a card should show: the requested date when listed (or the
 * closest listed date to it), otherwise the nearest monthly expiry at least
 * two days out, otherwise the first expiry.
 */
export function pickExpiry(chain: Pick<Chain, 'expiries' | 'multiplier'>, wanted: string | undefined, now: Date): string {
  if (!chain.expiries.length) throw new SourceError('Options', 'the chain has no unexpired contracts');
  if (wanted && /^\d{4}-\d{2}-\d{2}$/.test(wanted)) {
    if (chain.expiries.includes(wanted)) return wanted;
    const t = Date.parse(`${wanted}T00:00:00Z`);
    return [...chain.expiries].sort((a, b) => Math.abs(Date.parse(`${a}T00:00:00Z`) - t) - Math.abs(Date.parse(`${b}T00:00:00Z`) - t))[0];
  }
  const floor = now.getTime() + 2 * 86_400_000;
  const monthly = monthlyExpiries(chain).find((e) => Date.parse(`${e}T00:00:00Z`) >= floor);
  return monthly ?? chain.expiries.find((e) => Date.parse(`${e}T00:00:00Z`) >= floor) ?? chain.expiries[0];
}

/** The underlying level options of this expiry are priced against (the forward on Deribit, spot elsewhere). */
export function underlyingFor(chain: Chain, expiry: string): number {
  return chain.quotes.find((q) => q.expiry === expiry && q.underlying != null)?.underlying ?? chain.spot;
}

/** Listed strike closest to the underlying for one expiry. */
export function atmStrike(chain: Chain, expiry: string): number | null {
  const ref = underlyingFor(chain, expiry);
  let best: number | null = null;
  for (const q of chain.quotes) {
    if (q.expiry !== expiry) continue;
    if (best === null || Math.abs(q.strike - ref) < Math.abs(best - ref)) best = q.strike;
  }
  return best;
}

/**
 * At-the-money implied vol for an expiry: the average of the call and put
 * implied vols at the strike nearest the underlying, moving outward to the
 * next strikes when that one has no usable quote.
 */
export function atmIv(chain: Chain, expiry: string): number | null {
  const ref = underlyingFor(chain, expiry);
  const byStrike = new Map<number, number[]>();
  for (const q of chain.quotes) {
    if (q.expiry !== expiry || q.iv === null) continue;
    byStrike.set(q.strike, [...(byStrike.get(q.strike) ?? []), q.iv]);
  }
  const near = [...byStrike.keys()].sort((a, b) => Math.abs(a - ref) - Math.abs(b - ref)).slice(0, 3);
  for (const k of near) {
    if (Math.abs(k / ref - 1) > 0.1) break;
    const ivs = byStrike.get(k) as number[];
    return ivs.reduce((a, b) => a + b, 0) / ivs.length;
  }
  return null;
}

/** Out-of-the-money implied vol by strike for one expiry: puts below the underlying, calls at and above. */
export function otmSmile(chain: Chain, expiry: string): { strike: number; iv: number; type: OptionType }[] {
  const ref = underlyingFor(chain, expiry);
  const out: { strike: number; iv: number; type: OptionType }[] = [];
  for (const q of chain.quotes) {
    if (q.expiry !== expiry || q.iv === null) continue;
    if ((q.type === 'P' && q.strike < ref) || (q.type === 'C' && q.strike >= ref)) out.push({ strike: q.strike, iv: q.iv, type: q.type });
  }
  return out.sort((a, b) => a.strike - b.strike);
}
