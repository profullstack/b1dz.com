/**
 * Pure helpers over SEC XBRL company facts: pick a concept across the tags
 * companies have used for it, derive standalone quarters, trailing twelve
 * months and point-in-time values (what was on file on a given date).
 */
import type { CompanyFacts, XbrlFact } from '../../lib/sec.js';

const DAY = 86_400_000;

export interface Flow {
  start: string;
  end: string;
  val: number;
  /** Filing date of the report this value comes from. */
  filed: string;
  days: number;
  derived?: boolean;
}

export interface Stock {
  end: string;
  val: number;
  filed: string;
}

function days(start: string, end: string): number {
  return Math.round((Date.parse(end) - Date.parse(start)) / DAY) + 1;
}

/**
 * Facts for the first tags that have them, merged: a period reported under an
 * earlier tag in the list wins. `prefer: 'first'` keeps the value as first
 * filed (point in time); 'last' keeps the latest restatement (comparable
 * across splits).
 */
export function pickFacts(cf: CompanyFacts, tags: string[], unit = 'USD', prefer: 'first' | 'last' = 'first', taxonomy = 'us-gaap'): XbrlFact[] {
  const byPeriod = new Map<string, XbrlFact>();
  for (const tag of tags) {
    const facts = cf.facts?.[taxonomy]?.[tag]?.units?.[unit] ?? [];
    const mine = new Map<string, XbrlFact>();
    for (const f of facts) {
      if (typeof f.val !== 'number' || !f.end || !f.filed) continue;
      const key = `${f.start ?? ''}|${f.end}`;
      const have = mine.get(key);
      if (!have || (prefer === 'first' ? f.filed < have.filed! : f.filed > have.filed!)) mine.set(key, f);
    }
    for (const [k, f] of mine) if (!byPeriod.has(k)) byPeriod.set(k, f);
  }
  return [...byPeriod.values()];
}

export function flows(facts: XbrlFact[]): Flow[] {
  return facts.filter((f) => f.start).map((f) => ({ start: f.start!, end: f.end, val: f.val, filed: f.filed!, days: days(f.start!, f.end) }));
}

export function stocks(facts: XbrlFact[]): Stock[] {
  return facts.filter((f) => !f.start).map((f) => ({ end: f.end, val: f.val, filed: f.filed! })).sort((a, b) => a.end.localeCompare(b.end));
}

const isQuarter = (f: Flow): boolean => f.days >= 80 && f.days <= 100;
const isYear = (f: Flow): boolean => f.days >= 350 && f.days <= 380;

/** Fiscal years, oldest first. */
export function annual(all: Flow[]): Flow[] {
  return all.filter(isYear).sort((a, b) => a.end.localeCompare(b.end));
}

/**
 * Standalone quarters, oldest first. Companies report three quarters in
 * 10-Qs and only the full year in the 10-K, so the fourth quarter is the year
 * minus the three reported quarters (flagged `derived`).
 */
export function quarterly(all: Flow[]): Flow[] {
  const q = all.filter(isQuarter);
  const byEnd = new Map(q.map((f) => [f.end, f]));
  for (const y of all.filter(isYear)) {
    if (byEnd.has(y.end)) continue;
    const inside = q.filter((f) => f.start >= y.start && f.end < y.end);
    if (inside.length !== 3) continue;
    const last = inside.reduce((a, b) => (a.end > b.end ? a : b));
    const start = new Date(Date.parse(last.end) + DAY).toISOString().slice(0, 10);
    byEnd.set(y.end, { start, end: y.end, val: y.val - inside.reduce((a, f) => a + f.val, 0), filed: y.filed, days: days(start, y.end), derived: true });
  }
  return [...byEnd.values()].sort((a, b) => a.end.localeCompare(b.end));
}

/** Sum of the four most recent quarters on file at `asOf` (YYYY-MM-DD); null unless they are four consecutive quarters. */
export function ttmAsOf(quarters: Flow[], asOf: string): { val: number; end: string } | null {
  const known = quarters.filter((q) => q.filed <= asOf);
  if (known.length < 4) return null;
  const last4 = known.slice(-4);
  const span = days(last4[0].start, last4[3].end);
  if (span < 350 || span > 380) return null;
  return { val: last4.reduce((a, q) => a + q.val, 0), end: last4[3].end };
}

/** The most recent value on file at `asOf`. */
export function latestAsOf<T extends { end: string; filed: string }>(series: T[], asOf: string): T | null {
  let best: T | null = null;
  for (const s of series) if (s.filed <= asOf && (!best || s.end > best.end)) best = s;
  return best;
}

const SPLITS = [2, 3, 4, 5, 6, 7, 8, 10, 15, 20, 25, 30, 40, 50];

/** The stock-split ratio closest to `r` (>1 forward, <1 reverse) when within 12%, else null. */
export function splitRatio(r: number): number | null {
  if (!Number.isFinite(r) || r <= 0) return null;
  const forward = r >= 1;
  const x = forward ? r : 1 / r;
  if (x < 1.8) return null;
  const nice = SPLITS.reduce((a, b) => (Math.abs(b - x) < Math.abs(a - x) ? b : a));
  if (Math.abs(nice - x) / nice > 0.12) return null;
  return forward ? nice : 1 / nice;
}

/**
 * As-reported share counts restated to today's share basis: a jump between
 * consecutive periods that matches a split ratio is treated as a split and
 * applied to every earlier period. Input and output are oldest first.
 */
export function splitAdjust<T extends { val: number }>(series: T[]): T[] {
  const out = series.map((s) => ({ ...s }));
  let factor = 1;
  for (let i = out.length - 1; i > 0; i--) {
    out[i].val = series[i].val * factor;
    const ratio = splitRatio(series[i].val / series[i - 1].val);
    if (ratio !== null) factor *= ratio;
  }
  if (out.length) out[0].val = series[0].val * factor;
  return out;
}

export const TAGS = {
  revenue: ['RevenueFromContractWithCustomerExcludingAssessedTax', 'Revenues', 'SalesRevenueNet', 'RevenueFromContractWithCustomerIncludingAssessedTax', 'RevenuesNetOfInterestExpense', 'SalesRevenueGoodsNet'],
  netIncome: ['NetIncomeLoss', 'ProfitLoss', 'NetIncomeLossAvailableToCommonStockholdersBasic'],
  equity: ['StockholdersEquity', 'StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest'],
  dilutedShares: ['WeightedAverageNumberOfDilutedSharesOutstanding', 'WeightedAverageNumberOfSharesOutstandingBasic'],
  epsDiluted: ['EarningsPerShareDiluted', 'EarningsPerShareBasicAndDiluted', 'EarningsPerShareBasic'],
};

export interface Multiples {
  t: number;
  pe: number | null;
  ps: number | null;
  pb: number | null;
  marketCap: number | null;
}

export interface Fundamentals {
  netIncome: Flow[];
  revenue: Flow[];
  equity: Stock[];
  /** Quarterly weighted diluted shares, split-adjusted to today's basis. */
  shares: Flow[];
}

export function fundamentals(cf: CompanyFacts): Fundamentals {
  const q = (tags: string[], unit = 'USD'): Flow[] => quarterly(flows(pickFacts(cf, tags, unit, 'first')));
  // Weighted shares: standalone quarters only (a full-year average is not a quarter-end count).
  const shares = flows(pickFacts(cf, TAGS.dilutedShares, 'shares', 'first')).filter(isQuarter).sort((a, b) => a.end.localeCompare(b.end));
  return { netIncome: q(TAGS.netIncome), revenue: q(TAGS.revenue), equity: stocks(pickFacts(cf, TAGS.equity, 'USD', 'first')), shares: splitAdjust(shares) };
}

/**
 * Valuation multiples at each price date, using only figures on file by that
 * date: market value = close x diluted shares (latest quarter), over trailing
 * four-quarter earnings and revenue and the latest book equity.
 */
export function multiplesAt(f: Fundamentals, prices: { t: number; c: number }[]): Multiples[] {
  return prices.map((p) => {
    const asOf = new Date(p.t).toISOString().slice(0, 10);
    const sh = latestAsOf(f.shares, asOf);
    const marketCap = sh ? p.c * sh.val : null;
    const ni = ttmAsOf(f.netIncome, asOf);
    const rev = ttmAsOf(f.revenue, asOf);
    const eq = latestAsOf(f.equity, asOf);
    return {
      t: p.t,
      marketCap,
      pe: marketCap !== null && ni && ni.val > 0 ? marketCap / ni.val : null,
      ps: marketCap !== null && rev && rev.val > 0 ? marketCap / rev.val : null,
      pb: marketCap !== null && eq && eq.val > 0 ? marketCap / eq.val : null,
    };
  });
}

/** The last bar of each calendar month. */
export function monthEnds<T extends { t: number }>(bars: T[]): T[] {
  const out: T[] = [];
  for (let i = 0; i < bars.length; i++) {
    const next = bars[i + 1];
    if (!next || new Date(next.t).getUTCMonth() !== new Date(bars[i].t).getUTCMonth()) out.push(bars[i]);
  }
  return out;
}
