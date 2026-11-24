/** Rates & Curves: the U.S. tab (Treasury par curve history, TIPS real yields, bills, breakevens). */
import { SourceError, type CardDef, type Ctx, type Row } from '../../types.js';
import { tableToSeries, treasuryTable, yearsBetween, type TreasuryTable } from './curves.js';
import { RANGE_CHOICES, bpDiff, curveAt, latestDate, rangeStart, shiftBack, timePoints, valueAsOf, ymd, type TenorSeries } from './util.js';

const rangeParam = (def: string) => ({ name: 'range', label: 'Range', default: def, choices: RANGE_CHOICES });
const NOMINAL_URL = 'https://home.treasury.gov/resource-center/data-chart-center/interest-rates/TextView?type=daily_treasury_yield_curve';
const REAL_URL = 'https://home.treasury.gov/resource-center/data-chart-center/interest-rates/TextView?type=daily_treasury_real_yield_curve';
const BILL_URL = 'https://home.treasury.gov/resource-center/data-chart-center/interest-rates/TextView?type=daily_treasury_bill_rates';

/** Start of the window: the chosen range, but always far enough back for a one-year comparison. */
function windowStart(ctx: Ctx, range: string | undefined): { start: string; fetchFrom: string } {
  const start = rangeStart(range, ctx.now(), shiftBack(ymd(ctx.now()), '10Y'));
  const yearAgo = shiftBack(ymd(ctx.now()), '1Y');
  return { start, fetchFrom: start < yearAgo ? start : yearAgo };
}

async function curveSeries(ctx: Ctx, type: 'daily_treasury_yield_curve' | 'daily_treasury_real_yield_curve', from: string): Promise<TenorSeries[]> {
  const series = tableToSeries(await treasuryTable(ctx, type, yearsBetween(shiftBack(from, '1M'), ymd(ctx.now()))));
  if (!series.length) throw new SourceError('U.S. Treasury', `no ${type} rows`);
  return series;
}

const pick = (series: TenorSeries[], years: number): [string, number][] => series.find((s) => s.years === years)?.points ?? [];

/** a minus b on the dates both have, in the unit of `scale` (100 for basis points). */
export function spreadSeries(a: [string, number][], b: [string, number][], scale = 1): [string, number][] {
  const other = new Map(b);
  const out: [string, number][] = [];
  for (const [d, v] of a) {
    const w = other.get(d);
    if (w !== undefined) out.push([d, Math.round((v - w) * scale * 1000) / 1000]);
  }
  return out;
}

const usCurveHistory: CardDef = {
  id: 'rates.us-curve-history',
  title: 'Treasury Yields and the 2s10s Spread',
  source: 'U.S. Treasury',
  description: '2-, 10- and 30-year Treasury par yields through time and the 10-year minus 2-year spread.',
  params: [rangeParam('2Y')],
  async run(ctx, p) {
    const { start, fetchFrom } = windowStart(ctx, p.range);
    const series = await curveSeries(ctx, 'daily_treasury_yield_curve', fetchFrom);
    const y2 = pick(series, 2);
    const y10 = pick(series, 10);
    const y30 = pick(series, 30);
    const m3 = pick(series, 0.25);
    const s210 = spreadSeries(y10, y2, 100);
    const s3m10 = spreadSeries(y10, m3, 100);
    const latest = latestDate(series);
    const at = (pts: [string, number][], back?: string) => valueAsOf(pts, back ? shiftBack(latest, back) : latest)?.value ?? null;
    const row = (label: string, pts: [string, number][], bp = false): Row => {
      const now = at(pts);
      const d = (back: string) => (bp ? (now == null || at(pts, back) == null ? null : Math.round((now - (at(pts, back) as number)) * 10) / 10) : bpDiff(now, at(pts, back)));
      return { name: label, level: bp ? null : now, spread: bp ? now : null, d1m: d('1M'), d3m: d('3M'), d1y: d('1Y') };
    };
    return {
      blocks: [
        {
          kind: 'chart',
          title: 'Treasury par yields',
          xType: 'time',
          series: [
            { name: '2Y', points: timePoints(y2, start) },
            { name: '10Y', points: timePoints(y10, start) },
            { name: '30Y', points: timePoints(y30, start) },
          ],
          yFormat: 'pct',
          yDigits: 2,
        },
        { kind: 'chart', title: '10Y minus 2Y', xType: 'time', series: [{ name: '2s10s', points: timePoints(s210, start) }], yFormat: 'bp' },
        {
          kind: 'table',
          columns: [
            { key: 'name', label: latest },
            { key: 'level', label: 'Yield', format: 'pct', digits: 2 },
            { key: 'spread', label: 'Spread', format: 'bp' },
            { key: 'd1m', label: '1M chg', format: 'bp' },
            { key: 'd3m', label: '3M chg', format: 'bp' },
            { key: 'd1y', label: '1Y chg', format: 'bp' },
          ],
          rows: [row('2Y', y2), row('10Y', y10), row('30Y', y30), row('10Y - 2Y', s210, true), row('10Y - 3M', s3m10, true)],
        },
      ],
      sourceUrl: NOMINAL_URL,
      asOf: latest,
      notes: ['Par yield curve rates (constant maturity) from the daily Treasury file.'],
    };
  },
};

const usRealYields: CardDef = {
  id: 'rates.us-real-yields',
  title: 'TIPS Real Yield Curve',
  source: 'U.S. Treasury',
  description: 'Treasury par real yields (TIPS) by maturity against a month and a year ago, and their history.',
  params: [rangeParam('2Y')],
  async run(ctx, p) {
    const { start, fetchFrom } = windowStart(ctx, p.range);
    const series = await curveSeries(ctx, 'daily_treasury_real_yield_curve', fetchFrom);
    const latest = latestDate(series);
    const now = curveAt(series, latest);
    const m1 = curveAt(series, shiftBack(latest, '1M'));
    const y1 = curveAt(series, shiftBack(latest, '1Y'));
    const line = (v: (number | null)[]): [number, number][] => series.flatMap((s, i): [number, number][] => (v[i] == null ? [] : [[s.years, v[i] as number]]));
    return {
      blocks: [
        {
          kind: 'chart',
          title: 'Real yield curve',
          xType: 'number',
          xLabel: 'Years to maturity',
          series: [
            { name: latest, points: line(now.values) },
            { name: `1M ago (${m1.date})`, points: line(m1.values) },
            { name: `1Y ago (${y1.date})`, points: line(y1.values) },
          ].filter((s) => s.points.length),
          yFormat: 'pct',
          yDigits: 2,
        },
        {
          kind: 'chart',
          title: 'Real yields through time',
          xType: 'time',
          series: [5, 10, 30].map((y) => ({ name: `${y}Y real`, points: timePoints(pick(series, y), start) })),
          yFormat: 'pct',
          yDigits: 2,
        },
        {
          kind: 'table',
          columns: [
            { key: 'tenor', label: 'Tenor' },
            { key: 'now', label: latest, format: 'pct', digits: 2 },
            { key: 'd1m', label: '1M chg', format: 'bp' },
            { key: 'd1y', label: '1Y chg', format: 'bp' },
          ],
          rows: series.map((s, i) => ({ tenor: s.label, now: now.values[i], d1m: bpDiff(now.values[i], m1.values[i]), d1y: bpDiff(now.values[i], y1.values[i]) })),
        },
      ],
      sourceUrl: REAL_URL,
      asOf: latest,
      notes: ['Par real yields on Treasury Inflation-Protected Securities; the yield is what a holder earns above CPI inflation.'],
    };
  },
};

export interface BillRow {
  weeks: number;
  discount: [string, number][];
  coupon: [string, number][];
}

/** Bill-rate columns ("13 WEEKS BANK DISCOUNT", "13 WEEKS COUPON EQUIVALENT") grouped by maturity. */
export function billSeries(table: TreasuryTable): BillRow[] {
  const out = new Map<number, BillRow>();
  table.columns.forEach((c, i) => {
    const m = /^(\d+)\s+WEEKS?\s+(BANK DISCOUNT|COUPON EQUIVALENT)$/i.exec(c);
    if (!m) return;
    const weeks = Number(m[1]);
    let row = out.get(weeks);
    if (!row) out.set(weeks, (row = { weeks, discount: [], coupon: [] }));
    const target = m[2].toUpperCase().startsWith('BANK') ? row.discount : row.coupon;
    for (const r of table.rows) {
      const v = r.values[i];
      if (v !== null) target.push([r.date, v]);
    }
  });
  return [...out.values()].filter((r) => r.coupon.length || r.discount.length).sort((a, b) => a.weeks - b.weeks);
}

const usBills: CardDef = {
  id: 'rates.us-bills',
  title: 'Treasury Bill Rates',
  source: 'U.S. Treasury',
  description: 'Daily secondary-market Treasury bill rates by maturity: bank discount and coupon-equivalent yield.',
  params: [rangeParam('1Y')],
  async run(ctx, p) {
    const { start, fetchFrom } = windowStart(ctx, p.range);
    const table = await treasuryTable(ctx, 'daily_treasury_bill_rates', yearsBetween(shiftBack(fetchFrom, '1M'), ymd(ctx.now())));
    const bills = billSeries(table);
    if (!bills.length) throw new SourceError('U.S. Treasury', 'no bill rate rows');
    const latest = bills.reduce((a, b) => {
      const d = b.coupon[b.coupon.length - 1]?.[0] ?? '';
      return d > a ? d : a;
    }, '');
    const at = (pts: [string, number][], date: string) => valueAsOf(pts, date)?.value ?? null;
    const prev = table.rows.filter((r) => r.date < latest).pop()?.date ?? latest;
    const rows: Row[] = bills.map((b) => {
      const now = at(b.coupon, latest);
      return {
        bill: `${b.weeks}-week`,
        discount: at(b.discount, latest),
        coupon: now,
        d1d: bpDiff(now, at(b.coupon, prev)),
        d1m: bpDiff(now, at(b.coupon, shiftBack(latest, '1M'))),
        d1y: bpDiff(now, at(b.coupon, shiftBack(latest, '1Y'))),
      };
    });
    return {
      blocks: [
        {
          kind: 'table',
          columns: [
            { key: 'bill', label: 'Bill' },
            { key: 'discount', label: 'Bank discount', format: 'pct', digits: 2 },
            { key: 'coupon', label: 'Coupon equiv.', format: 'pct', digits: 2 },
            { key: 'd1d', label: '1D chg', format: 'bp' },
            { key: 'd1m', label: '1M chg', format: 'bp' },
            { key: 'd1y', label: '1Y chg', format: 'bp' },
          ],
          rows,
          footnote: 'Changes are in the coupon-equivalent yield.',
        },
        {
          kind: 'chart',
          title: 'Coupon-equivalent yield',
          xType: 'time',
          series: bills.filter((b) => [4, 13, 26, 52].includes(b.weeks)).map((b) => ({ name: `${b.weeks}-week`, points: timePoints(b.coupon, start) })),
          yFormat: 'pct',
          yDigits: 2,
        },
      ],
      sourceUrl: BILL_URL,
      asOf: latest,
      notes: ['Secondary-market quotes on the most recently auctioned bills. Bank discount is quoted on face value over a 360-day year; the coupon equivalent is comparable with note yields.'],
    };
  },
};

const usBreakevens: CardDef = {
  id: 'rates.us-breakevens',
  title: 'Breakeven Inflation',
  source: 'U.S. Treasury',
  description: 'Market-implied inflation: nominal Treasury par yield minus the TIPS real yield at each maturity, plus the 5-year, 5-year forward.',
  params: [rangeParam('2Y')],
  async run(ctx, p) {
    const { start, fetchFrom } = windowStart(ctx, p.range);
    const nominal = await curveSeries(ctx, 'daily_treasury_yield_curve', fetchFrom);
    const real = await curveSeries(ctx, 'daily_treasury_real_yield_curve', fetchFrom);
    const tenors = real.map((s) => s.years).filter((y) => nominal.some((n) => n.years === y));
    const be = new Map<number, [string, number][]>(tenors.map((y) => [y, spreadSeries(pick(nominal, y), pick(real, y))]));
    const be5 = be.get(5) ?? [];
    const be10 = be.get(10) ?? [];
    // Forward breakeven from simple compounding of the two spot breakevens: 2 x 10Y - 5Y.
    const five = new Map(be5);
    const fwd: [string, number][] = be10.flatMap(([d, v]): [string, number][] => (five.has(d) ? [[d, Math.round((2 * v - (five.get(d) as number)) * 1000) / 1000]] : []));
    const latest = be10[be10.length - 1]?.[0] ?? be5[be5.length - 1]?.[0];
    if (!latest) throw new SourceError('U.S. Treasury', 'nominal and real curves share no dates');
    const at = (pts: [string, number][], back?: string) => valueAsOf(pts, back ? shiftBack(latest, back) : latest)?.value ?? null;
    const rows: Row[] = tenors.map((y) => {
      const pts = be.get(y) ?? [];
      return {
        tenor: `${y}Y`,
        nominal: at(pick(nominal, y)),
        real: at(pick(real, y)),
        breakeven: at(pts),
        d1m: bpDiff(at(pts), at(pts, '1M')),
        d1y: bpDiff(at(pts), at(pts, '1Y')),
      };
    });
    rows.push({ tenor: '5Y5Y fwd', nominal: null, real: null, breakeven: at(fwd), d1m: bpDiff(at(fwd), at(fwd, '1M')), d1y: bpDiff(at(fwd), at(fwd, '1Y')) });
    return {
      blocks: [
        {
          kind: 'chart',
          title: 'Breakeven inflation rate',
          xType: 'time',
          series: [
            { name: '5Y', points: timePoints(be5, start) },
            { name: '10Y', points: timePoints(be10, start) },
            { name: '5Y5Y forward', points: timePoints(fwd, start) },
          ],
          yFormat: 'pct',
          yDigits: 2,
        },
        {
          kind: 'table',
          columns: [
            { key: 'tenor', label: latest },
            { key: 'nominal', label: 'Nominal', format: 'pct', digits: 2 },
            { key: 'real', label: 'Real', format: 'pct', digits: 2 },
            { key: 'breakeven', label: 'Breakeven', format: 'pct', digits: 2 },
            { key: 'd1m', label: '1M chg', format: 'bp' },
            { key: 'd1y', label: '1Y chg', format: 'bp' },
          ],
          rows,
        },
      ],
      sourceUrl: REAL_URL,
      asOf: latest,
      notes: [
        'Computed here: nominal par yield minus TIPS par real yield at the same maturity. It includes inflation and liquidity risk premia, so it is not a pure inflation forecast.',
        'The 5Y5Y forward is approximated as twice the 10-year breakeven minus the 5-year breakeven.',
      ],
    };
  },
};

export const usCards: CardDef[] = [usCurveHistory, usRealYields, usBills, usBreakevens];
