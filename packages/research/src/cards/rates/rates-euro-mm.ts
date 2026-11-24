/** Rates & Curves: the Euro area tab (ECB) and the Money markets tab (New York Fed). */
import { SourceError, type CardDef, type Ctx, type Row } from '../../types.js';
import { ecbCurves } from './curves.js';
import { rateChanges } from './rates-country.js';
import { DAY, RANGE_CHOICES, bpDiff, curveAt, dayMs, ecbCsv, latestDate, rangeStart, sdmxSeries, shiftBack, sortPoints, timePoints, valueAsOf, ymd } from './util.js';

const rangeParam = (def: string) => ({ name: 'range', label: 'Range', default: def, choices: RANGE_CHOICES });

// ---------- Euro area ----------

const eaCurve: CardDef = {
  id: 'rates.ea-curve',
  title: 'Euro Area Yield Curve: AAA vs All Issuers',
  source: 'ECB',
  description: 'ECB spot yield curve for AAA-rated euro area governments against the curve for all euro area government issuers.',
  async run(ctx) {
    const curves = await ecbCurves(ctx, ymd(ctx.now().getTime() - 50 * DAY), 'G_N_A+G_N_C');
    const aaa = curves.get('G_N_A') ?? [];
    const all = curves.get('G_N_C') ?? [];
    const latest = latestDate(aaa);
    if (!latest) throw new SourceError('ECB', 'no AAA curve observations');
    const a = curveAt(aaa, latest);
    const b = curveAt(all, latest);
    const prev = curveAt(aaa, shiftBack(latest, '1M'));
    const line = (series: typeof aaa, v: (number | null)[]): [number, number][] => series.flatMap((s, i): [number, number][] => (v[i] == null ? [] : [[s.years, v[i] as number]]));
    const rows: Row[] = aaa.map((s, i) => {
      const j = all.findIndex((x) => x.years === s.years);
      const other = j < 0 ? null : b.values[j];
      return { tenor: s.label, aaa: a.values[i], all: other, spread: bpDiff(other, a.values[i]), d1m: bpDiff(a.values[i], prev.values[i]) };
    });
    return {
      blocks: [
        {
          kind: 'chart',
          title: 'Spot rates by maturity',
          xType: 'number',
          xLabel: 'Years to maturity',
          series: [
            { name: 'AAA issuers', points: line(aaa, a.values) },
            { name: 'All issuers', points: line(all, b.values) },
            { name: `AAA 1M ago (${prev.date})`, points: line(aaa, prev.values) },
          ].filter((s) => s.points.length),
          yFormat: 'pct',
          yDigits: 2,
        },
        {
          kind: 'table',
          columns: [
            { key: 'tenor', label: 'Tenor' },
            { key: 'aaa', label: 'AAA', format: 'pct', digits: 2 },
            { key: 'all', label: 'All issuers', format: 'pct', digits: 2 },
            { key: 'spread', label: 'All - AAA', format: 'bp' },
            { key: 'd1m', label: 'AAA 1M chg', format: 'bp' },
          ],
          rows,
        },
      ],
      sourceUrl: 'https://www.ecb.europa.eu/stats/financial_markets_and_interest_rates/euro_area_yield_curves/html/index.en.html',
      asOf: latest,
      notes: ['Zero-coupon spot rates from the ECB Svensson fit. The gap between the two curves is the average credit and liquidity premium of lower-rated euro area sovereigns.'],
    };
  },
};

const ECB_RATES: [string, string][] = [
  ['DFR', 'Deposit facility'],
  ['MRR_FR', 'Main refinancing'],
  ['MLFR', 'Marginal lending'],
];

const ecbKeyRates: CardDef = {
  id: 'rates.ecb-key-rates',
  title: 'ECB Key Interest Rates',
  source: 'ECB',
  description: 'Deposit facility, main refinancing and marginal lending rates through time, with the recent changes.',
  params: [rangeParam('10Y')],
  async run(ctx, p) {
    const start = rangeStart(p.range, ctx.now(), '1999-01-01');
    const text = await ecbCsv(ctx, 'FM', `D.U2.EUR.4F.KR.${ECB_RATES.map((r) => r[0]).join('+')}.LEV`, `startPeriod=${start}`);
    const got = sdmxSeries(text, 'PROVIDER_FM_ID');
    const dfr = got.get('DFR') ?? [];
    if (!dfr.length) throw new SourceError('ECB', 'no key interest rate observations');
    const last = dfr[dfr.length - 1][0];
    const changes = rateChanges(dfr).reverse().slice(0, 12);
    return {
      blocks: [
        {
          kind: 'stats',
          items: ECB_RATES.map(([code, name]) => {
            const pts = got.get(code) ?? [];
            return { label: name, value: pts[pts.length - 1]?.[1], format: 'pct' as const, digits: 2 };
          }),
        },
        {
          kind: 'chart',
          title: 'Key ECB rates',
          xType: 'time',
          series: ECB_RATES.map(([code, name]) => ({ name, points: timePoints(got.get(code) ?? []) })).filter((s) => s.points.length),
          yFormat: 'pct',
          yDigits: 2,
        },
        {
          kind: 'table',
          title: 'Deposit facility rate changes, newest first',
          columns: [
            { key: 'date', label: 'Effective', format: 'date' },
            { key: 'to', label: 'New rate', format: 'pct', digits: 2 },
            { key: 'move', label: 'Step', format: 'bp' },
            { key: 'from', label: 'Before', format: 'pct', digits: 2 },
          ],
          rows: changes.map((c) => ({ date: c.date, to: c.to, move: bpDiff(c.to, c.from), from: c.from })),
          footnote: changes.length ? undefined : 'No change inside the selected range.',
        },
      ],
      sourceUrl: 'https://www.ecb.europa.eu/stats/policy_and_exchange_rates/key_ecb_interest_rates/html/index.en.html',
      asOf: last,
      notes: ['The deposit facility rate is the one the ECB steers policy with.'],
    };
  },
};

const estr: CardDef = {
  id: 'rates.estr',
  title: 'Euro Short-Term Rate (€STR)',
  source: 'ECB',
  description: 'The euro overnight benchmark: volume-weighted rate, 25th and 75th percentile, volume and transaction count.',
  params: [rangeParam('1Y')],
  async run(ctx, p) {
    const start = rangeStart(p.range, ctx.now(), '2019-10-01');
    const got = sdmxSeries(await ecbCsv(ctx, 'EST', 'B.EU000A2X2A25.WT+TT+R25+R75+NT', `startPeriod=${start}`), 'DATA_TYPE_EST');
    const rate = got.get('WT') ?? [];
    if (!rate.length) throw new SourceError('ECB', 'no €STR observations');
    const col = (k: string) => new Map(got.get(k) ?? []);
    const [r25, r75, vol, n] = [col('R25'), col('R75'), col('TT'), col('NT')];
    const rows: Row[] = rate
      .slice(-12)
      .reverse()
      .map(([d, v]) => ({ date: d, rate: v, r25: r25.get(d) ?? null, r75: r75.get(d) ?? null, volume: vol.has(d) ? (vol.get(d) as number) * 1e6 : null, trades: n.get(d) ?? null }));
    return {
      blocks: [
        { kind: 'chart', title: '€STR', xType: 'time', series: [{ name: '€STR', points: timePoints(rate) }], yFormat: 'pct', yDigits: 3 },
        {
          kind: 'table',
          columns: [
            { key: 'date', label: 'Date', format: 'date' },
            { key: 'rate', label: 'Rate', format: 'pct', digits: 3 },
            { key: 'r25', label: '25th pct', format: 'pct', digits: 2 },
            { key: 'r75', label: '75th pct', format: 'pct', digits: 2 },
            { key: 'volume', label: 'Volume (EUR)', format: 'compact' },
            { key: 'trades', label: 'Transactions', format: 'int' },
          ],
          rows,
        },
      ],
      sourceUrl: 'https://www.ecb.europa.eu/stats/financial_markets_and_interest_rates/euro_short-term_rate/html/index.en.html',
      asOf: rate[rate.length - 1][0],
      notes: ['Published each TARGET day at 08:00 CET for the previous day; unsecured overnight borrowing by euro area banks.'],
    };
  },
};

// ---------- Money markets: New York Fed ----------

export interface RefRate {
  effectiveDate: string;
  type: string;
  percentRate?: number;
  percentPercentile1?: number;
  percentPercentile25?: number;
  percentPercentile75?: number;
  percentPercentile99?: number;
  volumeInBillions?: number;
  targetRateFrom?: number;
  targetRateTo?: number;
  average30day?: number;
  average90day?: number;
  average180day?: number;
  index?: number;
}

const NYFED = 'https://markets.newyorkfed.org/api';
const RATE_ORDER = ['SOFR', 'EFFR', 'OBFR', 'TGCR', 'BGCR'];
const RATE_NAMES: Record<string, string> = {
  SOFR: 'SOFR (secured overnight financing)',
  EFFR: 'EFFR (effective federal funds)',
  OBFR: 'OBFR (overnight bank funding)',
  TGCR: 'TGCR (tri-party general collateral)',
  BGCR: 'BGCR (broad general collateral)',
};

async function refRates(ctx: Ctx, start: string): Promise<RefRate[]> {
  const body = await ctx.http.json<{ refRates?: RefRate[] }>(`${NYFED}/rates/all/search.json?startDate=${start}&endDate=${ymd(ctx.now())}`, {
    source: 'New York Fed',
    ttl: 900,
    timeoutMs: 30_000,
  });
  if (!body.refRates?.length) throw new SourceError('New York Fed', 'no reference rates in the response');
  return body.refRates;
}

/** Reference-rate rows to one [date, value] series per rate type for a numeric field. */
export function refSeries(rows: RefRate[], field: keyof RefRate): Map<string, [string, number][]> {
  const out = new Map<string, [string, number][]>();
  for (const r of rows) {
    const v = r[field];
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    let list = out.get(r.type);
    if (!list) out.set(r.type, (list = []));
    list.push([r.effectiveDate, v]);
  }
  for (const [k, v] of out) out.set(k, sortPoints(v));
  return out;
}

const referenceRates: CardDef = {
  id: 'rates.reference-rates',
  title: 'U.S. Overnight Reference Rates',
  source: 'New York Fed',
  description: 'SOFR, EFFR, OBFR, TGCR and BGCR: latest rate, the percentile distribution of trades and volume.',
  async run(ctx) {
    const rows = await refRates(ctx, ymd(ctx.now().getTime() - 45 * DAY));
    const byType = new Map<string, RefRate[]>();
    for (const r of rows) byType.set(r.type, [...(byType.get(r.type) ?? []), r]);
    const out: Row[] = [];
    let asOf = '';
    let target = '';
    for (const type of RATE_ORDER) {
      const list = (byType.get(type) ?? []).sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate));
      const last = list[list.length - 1];
      if (!last) continue;
      if (last.effectiveDate > asOf) asOf = last.effectiveDate;
      if (last.targetRateFrom != null && last.targetRateTo != null) target = `${last.targetRateFrom.toFixed(2)}% to ${last.targetRateTo.toFixed(2)}%`;
      const prev = list[list.length - 2];
      const monthAgo = valueAsOf(list.map((r): [string, number] => [r.effectiveDate, r.percentRate ?? NaN]), shiftBack(last.effectiveDate, '1M'));
      out.push({
        rate: RATE_NAMES[type] ?? type,
        date: last.effectiveDate,
        value: last.percentRate,
        d1d: bpDiff(last.percentRate, prev?.percentRate),
        d1m: bpDiff(last.percentRate, monthAgo?.value),
        p1: last.percentPercentile1,
        p25: last.percentPercentile25,
        p75: last.percentPercentile75,
        p99: last.percentPercentile99,
        volume: last.volumeInBillions,
      });
    }
    if (!out.length) throw new SourceError('New York Fed', 'no reference rates in the response');
    return {
      blocks: [
        {
          kind: 'table',
          columns: [
            { key: 'rate', label: 'Rate' },
            { key: 'date', label: 'Date', format: 'date' },
            { key: 'value', label: 'Rate', format: 'pct', digits: 2 },
            { key: 'd1d', label: '1D chg', format: 'bp' },
            { key: 'd1m', label: '1M chg', format: 'bp' },
            { key: 'p1', label: '1st', format: 'pct', digits: 2 },
            { key: 'p25', label: '25th', format: 'pct', digits: 2 },
            { key: 'p75', label: '75th', format: 'pct', digits: 2 },
            { key: 'p99', label: '99th', format: 'pct', digits: 2 },
            { key: 'volume', label: 'Volume $bn', format: 'int' },
          ],
          rows: out,
          footnote: target ? `Federal funds target range: ${target}.` : undefined,
        },
      ],
      sourceUrl: 'https://www.newyorkfed.org/markets/reference-rates',
      asOf,
      notes: ['Each rate is the volume-weighted median of the day\'s transactions; percentiles show how widely trades were dispersed.'],
    };
  },
};

const referenceHistory: CardDef = {
  id: 'rates.reference-rates-history',
  title: 'Overnight Rates History',
  source: 'New York Fed',
  description: 'SOFR, EFFR, OBFR, TGCR and BGCR through time, with the SOFR minus EFFR spread.',
  params: [rangeParam('1Y')],
  async run(ctx, p) {
    const rows = await refRates(ctx, rangeStart(p.range, ctx.now(), '2018-04-02'));
    const rate = refSeries(rows, 'percentRate');
    const sofr = rate.get('SOFR') ?? [];
    const effr = new Map(rate.get('EFFR') ?? []);
    const spread: [string, number][] = sofr.flatMap(([d, v]): [string, number][] => (effr.has(d) ? [[d, Math.round((v - (effr.get(d) as number)) * 1000) / 10]] : []));
    return {
      blocks: [
        {
          kind: 'chart',
          title: 'Overnight rates',
          xType: 'time',
          series: RATE_ORDER.map((t) => ({ name: t, points: timePoints(rate.get(t) ?? []) })).filter((s) => s.points.length),
          yFormat: 'pct',
          yDigits: 2,
        },
        { kind: 'chart', title: 'SOFR minus EFFR', xType: 'time', series: [{ name: 'SOFR - EFFR', points: timePoints(spread) }], yFormat: 'bp' },
      ],
      sourceUrl: 'https://www.newyorkfed.org/markets/reference-rates',
      asOf: sofr[sofr.length - 1]?.[0],
      notes: ['A SOFR above the federal funds rate, especially at month and quarter ends, points to pressure in repo funding.'],
    };
  },
};

const sofrAverages: CardDef = {
  id: 'rates.sofr-averages',
  title: 'SOFR Averages and Index',
  source: 'New York Fed',
  description: '30-, 90- and 180-day compounded SOFR averages and the SOFR Index.',
  params: [rangeParam('1Y')],
  async run(ctx, p) {
    const rows = (await refRates(ctx, rangeStart(p.range, ctx.now(), '2020-03-02'))).filter((r) => r.type === 'SOFRAI');
    if (!rows.length) throw new SourceError('New York Fed', 'no SOFR averages in the response');
    const a30 = refSeries(rows, 'average30day').get('SOFRAI') ?? [];
    const a90 = refSeries(rows, 'average90day').get('SOFRAI') ?? [];
    const a180 = refSeries(rows, 'average180day').get('SOFRAI') ?? [];
    const index = refSeries(rows, 'index').get('SOFRAI') ?? [];
    const last = (pts: [string, number][]) => pts[pts.length - 1]?.[1];
    const asOf = a30[a30.length - 1]?.[0] ?? index[index.length - 1]?.[0];
    const d = (pts: [string, number][]) => bpDiff(last(pts), asOf ? valueAsOf(pts, shiftBack(asOf, '1M'))?.value : null);
    return {
      blocks: [
        {
          kind: 'stats',
          items: [
            { label: '30-day average', value: last(a30), format: 'pct', digits: 4 },
            { label: '90-day average', value: last(a90), format: 'pct', digits: 4 },
            { label: '180-day average', value: last(a180), format: 'pct', digits: 4 },
            { label: 'SOFR Index', value: last(index), format: 'num', digits: 6 },
            { label: '30-day, 1M change', value: d(a30), format: 'bp' },
            { label: '90-day, 1M change', value: d(a90), format: 'bp' },
          ],
        },
        {
          kind: 'chart',
          title: 'Compounded SOFR averages',
          xType: 'time',
          series: [
            { name: '30-day', points: timePoints(a30) },
            { name: '90-day', points: timePoints(a90) },
            { name: '180-day', points: timePoints(a180) },
          ],
          yFormat: 'pct',
          yDigits: 2,
        },
      ],
      sourceUrl: 'https://www.newyorkfed.org/markets/reference-rates/sofr-averages-and-index',
      asOf,
      notes: ['Averages compound SOFR over the trailing window; the index (1.0 on 2 April 2018) lets you compute compounded SOFR between any two dates.'],
    };
  },
};

export interface RepoOperation {
  operationDate: string;
  operationType: string;
  operationMethod?: string;
  closeTime?: string;
  term?: string;
  termCalenderDays?: number;
  maturityDate?: string;
  totalAmtSubmitted?: number;
  totalAmtAccepted?: number;
  acceptedCpty?: number;
  details?: { securityType?: string; amtAccepted?: number; percentOfferingRate?: number; percentAwardRate?: number; percentWeightedAverageRate?: number }[];
}

/** Operation rows for a table: the rate is the award rate when given, else the offering rate. */
export function repoRows(ops: RepoOperation[]): Row[] {
  return ops
    .map((o) => {
      const rated = o.details?.find((d) => d.percentAwardRate != null || d.percentWeightedAverageRate != null || d.percentOfferingRate != null);
      return {
        date: o.operationDate,
        type: o.operationType,
        close: o.closeTime ?? '',
        term: o.term === 'Overnight' ? `Overnight (${o.termCalenderDays ?? 1}d)` : `${o.term ?? ''} ${o.termCalenderDays ?? ''}d`.trim(),
        method: o.operationMethod ?? '',
        submitted: o.totalAmtSubmitted ?? null,
        accepted: o.totalAmtAccepted ?? null,
        rate: rated?.percentAwardRate ?? rated?.percentWeightedAverageRate ?? rated?.percentOfferingRate ?? null,
        counterparties: o.acceptedCpty ?? null,
      };
    })
    .sort((a, b) => b.date.localeCompare(a.date) || b.close.localeCompare(a.close) || a.type.localeCompare(b.type));
}

const repoOperations: CardDef = {
  id: 'rates.repo-operations',
  title: 'Fed Repo and Reverse Repo Operations',
  source: 'New York Fed',
  description: 'Open market desk repo and reverse repo operations over the last two weeks: amounts submitted and accepted, and the rate.',
  async run(ctx) {
    const body = await ctx.http.json<{ repo?: { operations?: RepoOperation[] } }>(`${NYFED}/rp/all/all/results/lastTwoWeeks.json`, { source: 'New York Fed', ttl: 900 });
    const ops = body.repo?.operations ?? [];
    if (!ops.length) throw new SourceError('New York Fed', 'no repo operations in the last two weeks');
    const rows = repoRows(ops);
    const rrp = ops.filter((o) => o.operationType === 'Reverse Repo').sort((a, b) => a.operationDate.localeCompare(b.operationDate));
    const chart: [number, number][] = rrp.map((o) => [dayMs(o.operationDate), (o.totalAmtAccepted ?? 0) / 1e9]);
    return {
      blocks: [
        {
          kind: 'table',
          columns: [
            { key: 'date', label: 'Date', format: 'date' },
            { key: 'type', label: 'Operation' },
            { key: 'close', label: 'Close (ET)' },
            { key: 'term', label: 'Term' },
            { key: 'method', label: 'Method' },
            { key: 'submitted', label: 'Submitted', format: 'usdCompact' },
            { key: 'accepted', label: 'Accepted', format: 'usdCompact' },
            { key: 'rate', label: 'Rate', format: 'pct', digits: 2 },
            { key: 'counterparties', label: 'Cpty', format: 'int' },
          ],
          rows,
        },
        ...(chart.length > 1 ? [{ kind: 'chart' as const, title: 'Reverse repo accepted ($bn)', xType: 'time' as const, series: [{ name: 'ON RRP', points: chart }], yFormat: 'num' as const, yDigits: 2 }] : []),
      ],
      sourceUrl: 'https://www.newyorkfed.org/markets/desk-operations/repo',
      asOf: rows[0]?.date as string,
      notes: ['Repo operations lend cash against Treasury, agency and mortgage collateral (the standing repo facility); reverse repos take cash in from money funds and others at the overnight RRP rate.'],
    };
  },
};

export const euroCards: CardDef[] = [eaCurve, ecbKeyRates, estr];
export const moneyMarketCards: CardDef[] = [referenceRates, referenceHistory, sofrAverages, repoOperations];
