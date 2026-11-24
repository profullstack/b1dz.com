/**
 * Daily euro foreign exchange reference rates (ECB), served by Frankfurter:
 * one request returns every published currency against the U.S. dollar.
 * Plus the pure maths the currency cards share: crosses, currency strength.
 */
import { pctChange } from '../../format.js';
import { SourceError, type Ctx } from '../../types.js';
import { valueAt, type Point } from './util.js';

export const FX_SOURCE = 'ECB reference rates (Frankfurter)';
export const FX_URL = 'https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/index.en.html';
export const FX_NOTE = 'ECB euro reference rates, set once each working day around 14:15 CET and crossed here into other pairs. Reference fixings, not tradable quotes.';

export const MAJORS = ['USD', 'EUR', 'JPY', 'GBP', 'CHF', 'CAD', 'AUD', 'NZD'] as const;

export const CURRENCY_NAMES: Record<string, string> = {
  USD: 'U.S. dollar', EUR: 'Euro', JPY: 'Japanese yen', GBP: 'British pound', CHF: 'Swiss franc', CAD: 'Canadian dollar',
  AUD: 'Australian dollar', NZD: 'New Zealand dollar', NOK: 'Norwegian krone', SEK: 'Swedish krona', DKK: 'Danish krone',
  PLN: 'Polish zloty', CZK: 'Czech koruna', HUF: 'Hungarian forint', RON: 'Romanian leu', ISK: 'Icelandic krona',
  CNY: 'Chinese yuan', HKD: 'Hong Kong dollar', SGD: 'Singapore dollar', KRW: 'South Korean won', INR: 'Indian rupee',
  IDR: 'Indonesian rupiah', MYR: 'Malaysian ringgit', PHP: 'Philippine peso', THB: 'Thai baht', MXN: 'Mexican peso',
  BRL: 'Brazilian real', TRY: 'Turkish lira', ZAR: 'South African rand', ILS: 'Israeli shekel',
};

export const REGIONS: { name: string; currencies: string[] }[] = [
  { name: 'G10', currencies: ['EUR', 'JPY', 'GBP', 'CHF', 'CAD', 'AUD', 'NZD', 'NOK', 'SEK'] },
  { name: 'Europe', currencies: ['DKK', 'PLN', 'CZK', 'HUF', 'RON', 'ISK'] },
  { name: 'Asia', currencies: ['CNY', 'HKD', 'SGD', 'KRW', 'INR', 'IDR', 'MYR', 'PHP', 'THB'] },
  { name: 'Americas', currencies: ['MXN', 'BRL'] },
  { name: 'EM (other)', currencies: ['TRY', 'ZAR', 'ILS'] },
];

/** Currencies the market quotes as dollars per unit (EURUSD); everything else is units per dollar (USDJPY). */
const DOLLAR_QUOTED = new Set(['EUR', 'GBP', 'AUD', 'NZD']);

export function marketPair(currency: string): { pair: string; inverted: boolean } {
  return DOLLAR_QUOTED.has(currency) ? { pair: `${currency}USD`, inverted: true } : { pair: `USD${currency}`, inverted: false };
}

/** Units of each currency per one U.S. dollar, by day. USD itself is 1. */
export interface FxPanel {
  /** Dates oldest first, ms epoch. */
  dates: number[];
  /** currency -> units per USD for each date (NaN when not published that day). */
  perUsd: Record<string, number[]>;
}

/** Frankfurter range response with base=USD: { rates: { "2026-11-20": { EUR: 0.91, ... }, ... } }. */
export function parseFxPanel(body: unknown): FxPanel {
  const rates = (body as { rates?: Record<string, Record<string, number>> })?.rates ?? {};
  const days = Object.keys(rates)
    .filter((d) => !Number.isNaN(Date.parse(`${d}T00:00:00Z`)))
    .sort();
  const perUsd: Record<string, number[]> = { USD: days.map(() => 1) };
  days.forEach((day, i) => {
    for (const [ccy, v] of Object.entries(rates[day] ?? {})) {
      if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) continue;
      (perUsd[ccy] ??= days.map(() => NaN))[i] = v;
    }
  });
  return { dates: days.map((d) => Date.parse(`${d}T00:00:00Z`)), perUsd };
}

export async function fxPanel(ctx: Ctx, start: string): Promise<FxPanel> {
  const from = start < '1999-01-04' ? '1999-01-04' : start;
  const body = await ctx.http.json<unknown>(`https://api.frankfurter.dev/v1/${from}..?base=USD`, { source: FX_SOURCE, ttl: 3600, timeoutMs: 30_000 });
  const panel = parseFxPanel(body);
  if (panel.dates.length < 2) throw new SourceError(FX_SOURCE, 'no rates returned');
  return panel;
}

/** Price of one `base` in `quote` over time (oldest first), skipping days either leg is missing. */
export function crossSeries(panel: FxPanel, base: string, quote: string): Point[] {
  const b = panel.perUsd[base];
  const q = panel.perUsd[quote];
  if (!b || !q) return [];
  const out: Point[] = [];
  panel.dates.forEach((t, i) => {
    const v = q[i] / b[i];
    if (Number.isFinite(v) && v > 0) out.push([t, v]);
  });
  return out;
}

/** Latest price of one `base` in `quote`. */
export function crossRate(panel: FxPanel, base: string, quote: string): number | null {
  const s = crossSeries(panel, base, quote);
  return s.length ? s[s.length - 1][1] : null;
}

/** Percent change in the value of `base` measured in `quote` from the last fixing on or before `from` to the latest. */
export function crossChange(panel: FxPanel, base: string, quote: string, from: number): number | null {
  const s = crossSeries(panel, base, quote);
  if (!s.length) return null;
  return pctChange(s[s.length - 1][1], valueAt(s, from));
}

export interface Strength {
  currency: string;
  /** Average percent move against the other currencies in the set. */
  average: number | null;
  /** Percent move against the dollar alone (null for the dollar itself). */
  vsUsd: number | null;
  strongestAgainst?: string;
  weakestAgainst?: string;
}

/** Each currency's average move against the others in `set` since `from`, strongest first. */
export function currencyStrength(panel: FxPanel, set: readonly string[], from: number): Strength[] {
  const out: Strength[] = set.map((c) => {
    const moves = set
      .filter((o) => o !== c)
      .map((o) => ({ o, v: crossChange(panel, c, o, from) }))
      .filter((m): m is { o: string; v: number } => m.v !== null);
    const sorted = [...moves].sort((a, b) => b.v - a.v);
    return {
      currency: c,
      average: moves.length ? moves.reduce((s, m) => s + m.v, 0) / moves.length : null,
      vsUsd: c === 'USD' ? null : crossChange(panel, c, 'USD', from),
      strongestAgainst: sorted[0]?.o,
      weakestAgainst: sorted[sorted.length - 1]?.o,
    };
  });
  return out.sort((a, b) => (b.average ?? -Infinity) - (a.average ?? -Infinity));
}

/** Strength index over time: for each day, the currency's average move against the others since the first day. */
export function strengthSeries(panel: FxPanel, set: readonly string[], currency: string, from: number): Point[] {
  const start = panel.dates.findIndex((t) => t >= from);
  if (start < 0) return [];
  const out: Point[] = [];
  const mine = panel.perUsd[currency];
  if (!mine) return [];
  for (let i = start; i < panel.dates.length; i++) {
    let sum = 0;
    let n = 0;
    for (const o of set) {
      if (o === currency) continue;
      const other = panel.perUsd[o];
      if (!other) continue;
      const now = other[i] / mine[i];
      const then = other[start] / mine[start];
      if (Number.isFinite(now) && Number.isFinite(then) && then > 0) {
        sum += (now / then - 1) * 100;
        n++;
      }
    }
    if (n) out.push([panel.dates[i], sum / n]);
  }
  return out;
}
