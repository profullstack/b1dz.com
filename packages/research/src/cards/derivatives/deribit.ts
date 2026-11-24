/** Deribit public API (v2, no key): shared request helper and parsers. */
import { SourceError, type Ctx } from '../../types.js';
import type { OptionType } from './optionmath.js';
import type { RawChain, RawQuote } from './chain.js';

export const DERIBIT = 'Deribit';
const BASE = 'https://www.deribit.com/api/v2/public';

interface Envelope<T> {
  result?: T;
  error?: { code?: number; message?: string; data?: { reason?: string; param?: string } };
}

export async function deribit<T>(ctx: Ctx, method: string, params: Record<string, string | number>, ttl = 60): Promise<T> {
  const qs = Object.entries(params)
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join('&');
  const body = await ctx.http.json<Envelope<T>>(`${BASE}/${method}?${qs}`, { source: DERIBIT, ttl });
  if (body.error || body.result === undefined) {
    throw new SourceError(DERIBIT, `${method}: ${body.error?.message ?? 'no result'}${body.error?.data?.param ? ` (${body.error.data.param})` : ''}`);
  }
  return body.result;
}

const MON = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

/** "26MAR27" to 2027-03-26. */
export function parseDeribitDate(s: string): string | null {
  const m = /^(\d{1,2})([A-Z]{3})(\d{2})$/.exec(s);
  if (!m) return null;
  const month = MON.indexOf(m[2]);
  if (month < 0) return null;
  return `20${m[3]}-${String(month + 1).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}

export interface DeribitInstrument {
  currency: string;
  kind: 'option' | 'future' | 'perpetual';
  /** YYYY-MM-DD; absent for perpetuals. */
  expiry?: string;
  strike?: number;
  type?: OptionType;
}

/** BTC-26MAR27-85000-P, BTC-29JAN27, BTC-PERPETUAL. Strikes may use "d" as the decimal point (XRP_USDC-...-0d55-C). */
export function parseInstrument(name: string): DeribitInstrument | null {
  const p = name.split('-');
  if (p.length === 2 && p[1] === 'PERPETUAL') return { currency: p[0], kind: 'perpetual' };
  const expiry = p[1] ? parseDeribitDate(p[1]) : null;
  if (!expiry) return null;
  if (p.length === 2) return { currency: p[0], kind: 'future', expiry };
  if (p.length === 4 && (p[3] === 'C' || p[3] === 'P')) {
    const strike = Number(p[2].replace('d', '.'));
    if (!Number.isFinite(strike)) return null;
    return { currency: p[0], kind: 'option', expiry, strike, type: p[3] };
  }
  return null;
}

export interface BookSummary {
  instrument_name: string;
  bid_price?: number | null;
  ask_price?: number | null;
  last?: number | null;
  mark_price?: number | null;
  mark_iv?: number | null;
  open_interest?: number | null;
  volume?: number | null;
  volume_usd?: number | null;
  underlying_price?: number | null;
  underlying_index?: string | null;
  estimated_delivery_price?: number | null;
  price_change?: number | null;
  mid_price?: number | null;
  creation_timestamp?: number;
}

/**
 * Option book summaries to quotes. Deribit quotes inverse options in the
 * coin: prices are multiplied by each expiry's underlying (forward) price to
 * give USD. Open interest and volume stay in coins (one contract = 1 coin).
 */
export function parseOptionSummaries(rows: BookSummary[]): RawQuote[] {
  const out: RawQuote[] = [];
  for (const r of rows) {
    const id = parseInstrument(r.instrument_name);
    if (!id || id.kind !== 'option' || !id.expiry || id.strike === undefined || !id.type) continue;
    const fwd = typeof r.underlying_price === 'number' && r.underlying_price > 0 ? r.underlying_price : null;
    if (fwd === null) continue;
    const usd = (v: number | null | undefined): number | null => (typeof v === 'number' && v > 0 ? v * fwd : null);
    out.push({
      expiry: id.expiry,
      strike: id.strike,
      type: id.type,
      bid: usd(r.bid_price),
      ask: usd(r.ask_price),
      last: usd(r.last),
      volume: typeof r.volume === 'number' ? r.volume : null,
      oi: typeof r.open_interest === 'number' ? r.open_interest : null,
      ivGiven: typeof r.mark_iv === 'number' && r.mark_iv > 0 ? r.mark_iv / 100 : null,
      underlying: fwd,
    });
  }
  return out;
}

export async function indexPrice(ctx: Ctx, currency: string): Promise<number> {
  const r = await deribit<{ index_price: number }>(ctx, 'get_index_price', { index_name: `${currency.toLowerCase()}_usd` });
  if (!(r.index_price > 0)) throw new SourceError(DERIBIT, `no ${currency} index price`);
  return r.index_price;
}

export async function deribitRawChain(ctx: Ctx, currency: 'BTC' | 'ETH'): Promise<RawChain> {
  const rows = await deribit<BookSummary[]>(ctx, 'get_book_summary_by_currency', { currency, kind: 'option' }, 120);
  const quotes = parseOptionSummaries(rows);
  if (!quotes.length) throw new SourceError(DERIBIT, `no ${currency} options listed`);
  const spot = await indexPrice(ctx, currency);
  const stamp = rows.find((r) => r.creation_timestamp)?.creation_timestamp;
  return {
    symbol: currency,
    spot,
    asOf: stamp ? new Date(stamp).toISOString().slice(0, 19) : undefined,
    source: DERIBIT,
    sourceUrl: `https://www.deribit.com/options/${currency}`,
    quotes,
    multiplier: 1,
    currency: 'USD',
    model: 'black76',
    periods: 365,
    preferGivenIv: true,
    expiryHourUtc: 8,
    notes: [
      `Deribit ${currency} options are quoted in ${currency}; prices are shown in USD at each expiry's forward. Open interest and volume are in ${currency} (one contract = 1 ${currency}).`,
      'Implied volatility is Deribit\'s mark IV; Greeks are Black-76 on the expiry forward.',
    ],
  };
}

interface TvChart {
  ticks?: number[];
  close?: number[];
  status?: string;
}

/** Daily closes of an instrument, oldest first, as [ms epoch, close]. */
export async function dailyCloses(ctx: Ctx, instrument: string, days: number): Promise<[number, number][]> {
  const end = ctx.now().getTime();
  const r = await deribit<TvChart>(
    ctx,
    'get_tradingview_chart_data',
    { instrument_name: instrument, start_timestamp: end - days * 86_400_000, end_timestamp: end, resolution: '1D' },
    900,
  );
  const out: [number, number][] = [];
  (r.ticks ?? []).forEach((t, i) => {
    const c = r.close?.[i];
    if (typeof c === 'number' && c > 0) out.push([t, c]);
  });
  if (!out.length) throw new SourceError(DERIBIT, `no price history for ${instrument}`);
  return out;
}
