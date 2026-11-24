/** Company > Estimates: expected vs reported EPS, surprise history, estimate revisions, the earnings press release. */
import { pctChange } from '../../format.js';
import { num } from '../../http.js';
import { NASDAQ, nasdaqGet, nasdaqSymbol } from '../../lib/nasdaq.js';
import { cikFor, companyFacts, filingDocs, filingIndexUrl, htmlToText, SEC, submissions } from '../../lib/sec.js';
import { SourceError, type CardDef, type Ctx, type Row, type StatItem } from '../../types.js';
import { SYMBOL, symbolOf, usDate } from './util.js';
import { flows, pickFacts, quarterly, TAGS } from './xbrl.js';

interface Eps {
  earningsPerShare?: { type?: string; period?: string; consensus?: number; earnings?: number }[];
}
interface EarningsDate {
  announcement?: string;
  reportText?: string;
}
interface Surprise {
  earningsSurpriseTable?: { rows?: { fiscalQtrEnd?: string; dateReported?: string; eps?: number; consensusForecast?: string | number; percentageSurprise?: string | number }[] | null } | null;
}

const api = (symbol: string): string => encodeURIComponent(nasdaqSymbol(symbol));
const page = (symbol: string, p: string): string => `https://www.nasdaq.com/market-activity/stocks/${nasdaqSymbol(symbol).toLowerCase()}/${p}`;

const earnings: CardDef = {
  id: 'equities.earnings',
  title: 'Earnings: expected vs reported',
  source: NASDAQ,
  description: 'Consensus and reported EPS for the last four quarters and the consensus for the next four, with the next report date when known.',
  params: [SYMBOL],
  async run(ctx, params) {
    const symbol = symbolOf(params);
    const [eps, date] = await Promise.all([
      nasdaqGet<Eps>(ctx, `/api/quote/${api(symbol)}/eps`, 3600),
      nasdaqGet<EarningsDate>(ctx, `/api/analyst/${api(symbol)}/earnings-date`, 3600).catch(() => null),
    ]);
    const list = eps.earningsPerShare ?? [];
    if (!list.length) throw new SourceError(NASDAQ, `no EPS data for ${symbol}`);
    const rows: Row[] = list.map((e) => {
      const reported = e.type === 'PreviousQuarter' ? (e.earnings ?? null) : null;
      return {
        period: e.period,
        status: e.type === 'PreviousQuarter' ? 'Reported' : 'Expected',
        consensus: e.consensus ?? null,
        reported,
        surprise: reported !== null && e.consensus != null ? reported - e.consensus : null,
        surprisePct: reported !== null ? pctChange(reported, e.consensus) : null,
      };
    });
    const next = list.find((e) => e.type === 'UpcomingQuarter');
    const lastQ = [...list].reverse().find((e) => e.type === 'PreviousQuarter');
    const when = `${date?.announcement ?? ''} ${date?.reportText ?? ''}`.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const items: StatItem[] = [
      { label: 'Latest quarter', value: lastQ?.period },
      { label: 'Reported EPS', value: lastQ?.earnings, format: 'usd' },
      { label: 'Consensus was', value: lastQ?.consensus, format: 'usd' },
      { label: 'Surprise', value: pctChange(lastQ?.earnings, lastQ?.consensus), format: 'signedPct' },
      { label: 'Next quarter', value: next?.period },
      { label: 'Next consensus', value: next?.consensus, format: 'usd' },
    ];
    return {
      blocks: [
        { kind: 'stats', items },
        {
          kind: 'chart',
          title: 'EPS: consensus vs reported',
          xType: 'category',
          categories: list.map((e) => e.period ?? ''),
          series: [
            { name: 'Consensus', points: list.map((e, i) => [i, e.consensus ?? 0] as [number, number]) },
            { name: 'Reported', points: list.flatMap((e, i) => (e.type === 'PreviousQuarter' ? [[i, e.earnings ?? 0] as [number, number]] : [])) },
          ],
          yFormat: 'usd',
        },
        {
          kind: 'table',
          columns: [
            { key: 'period', label: 'Fiscal quarter' },
            { key: 'status', label: 'Status' },
            { key: 'consensus', label: 'Consensus EPS', format: 'usd' },
            { key: 'reported', label: 'Reported EPS', format: 'usd' },
            { key: 'surprise', label: 'Surprise', format: 'signed', digits: 2 },
            { key: 'surprisePct', label: 'Surprise %', format: 'signedPct' },
          ],
          rows,
        },
      ],
      sourceUrl: page(symbol, 'earnings'),
      notes: [when || 'No confirmed date for the next report.', 'EPS on the analyst-consensus basis (Zacks via Nasdaq); it can exclude items that GAAP EPS includes.'],
    };
  },
};

export interface SurpriseRow {
  end: string;
  filed: string;
  eps: number;
  yoy: number | null;
  derived: boolean;
  consensus: number | null;
  surprisePct: number | null;
}

/** "Sep 2026" -> "2026-09". */
export function monthKey(s: string | undefined): string {
  const m = /^([A-Za-z]{3})[a-z]* (\d{4})$/.exec((s ?? '').trim());
  if (!m) return '';
  const i = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(m[1].toLowerCase());
  return i < 0 ? '' : `${m[2]}-${String(i + 1).padStart(2, '0')}`;
}

/** Twelve quarters of reported diluted EPS (newest first) with year-on-year change, joined to consensus by fiscal month. */
export function surpriseRows(quarters: { end: string; filed: string; val: number; derived?: boolean }[], consensus: Map<string, { consensus: number | null; surprisePct: number | null }>, count = 12): SurpriseRow[] {
  const byEnd = [...quarters].sort((a, b) => a.end.localeCompare(b.end));
  return byEnd
    .map((q, i) => {
      // Same fiscal quarter a year earlier: four quarters back, when that is 350 to 380 days before.
      const prior = byEnd[i - 4];
      const gap = prior ? (Date.parse(q.end) - Date.parse(prior.end)) / 86_400_000 : 0;
      const c = consensus.get(q.end.slice(0, 7));
      return {
        end: q.end,
        filed: q.filed,
        eps: q.val,
        yoy: prior && gap > 350 && gap < 380 ? pctChange(q.val, prior.val) : null,
        derived: Boolean(q.derived),
        consensus: c?.consensus ?? null,
        surprisePct: c?.surprisePct ?? null,
      };
    })
    .slice(-count)
    .reverse();
}

const surpriseHistory: CardDef = {
  id: 'equities.surprise-history',
  title: 'EPS history and surprises (12 quarters)',
  source: SEC,
  description: 'Twelve quarters of reported diluted EPS from SEC filings with year-on-year change, and the consensus surprise where published.',
  params: [SYMBOL],
  async run(ctx, params) {
    const symbol = symbolOf(params);
    const reg = await cikFor(ctx, symbol);
    const [cf, sup] = await Promise.all([
      companyFacts(ctx, reg.cik),
      nasdaqGet<Surprise>(ctx, `/api/company/${api(symbol)}/earnings-surprise`, 3600).catch(() => null),
    ]);
    // Values as last restated; the "filed" date shown is when the quarter was first reported.
    const firstFiled = new Map(quarterly(flows(pickFacts(cf, TAGS.epsDiluted, 'USD/shares', 'first'))).map((q) => [q.end, q.filed]));
    const quarters = quarterly(flows(pickFacts(cf, TAGS.epsDiluted, 'USD/shares', 'last'))).map((q) => ({ ...q, filed: firstFiled.get(q.end) ?? q.filed }));
    if (quarters.length < 2) throw new SourceError(SEC, `no quarterly EPS facts for ${symbol} (foreign filers on Form 20-F do not report quarters to the SEC)`);
    const consensus = new Map<string, { consensus: number | null; surprisePct: number | null }>();
    for (const r of sup?.earningsSurpriseTable?.rows ?? []) {
      const k = monthKey(r.fiscalQtrEnd);
      if (k) consensus.set(k, { consensus: num(r.consensusForecast), surprisePct: num(r.percentageSurprise) });
    }
    const rows = surpriseRows(quarters, consensus);
    const asc = [...rows].reverse();
    return {
      blocks: [
        { kind: 'chart', title: `${symbol} diluted EPS by quarter`, xType: 'category', style: 'bar', categories: asc.map((r) => r.end.slice(0, 7)), series: [{ name: 'Diluted EPS', points: asc.map((r, i) => [i, r.eps]) }], yFormat: 'usd' },
        {
          kind: 'table',
          columns: [
            { key: 'end', label: 'Quarter end' },
            { key: 'filed', label: 'First filed' },
            { key: 'eps', label: 'Diluted EPS (GAAP)', format: 'usd', digits: 2 },
            { key: 'yoy', label: 'YoY', format: 'signedPct' },
            { key: 'consensus', label: 'Consensus', format: 'usd' },
            { key: 'surprisePct', label: 'Surprise %', format: 'signedPct' },
            { key: 'note', label: '' },
          ],
          rows: rows.map((r) => ({ end: r.end, filed: r.filed, eps: r.eps, yoy: r.yoy, consensus: r.consensus, surprisePct: r.surprisePct, note: r.derived ? 'Q4 = year - 9M' : '' })),
        },
      ],
      sourceUrl: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${reg.cik}&type=10-Q`,
      asOf: rows[0]?.end,
      notes: [
        'EPS is GAAP diluted EPS from the XBRL data in 10-Q and 10-K filings, using the latest restated value (so it is comparable across stock splits). The fourth quarter is the fiscal year minus the first three quarters.',
        'Consensus and surprise come from Nasdaq (Zacks), which publishes the last four quarters only and measures surprise on its own adjusted EPS, not on GAAP EPS.',
      ],
    };
  },
};

interface Forecast {
  rows?: { fiscalEnd?: string; consensusEPSForecast?: number; highEPSForecast?: number; lowEPSForecast?: number; noOfEstimates?: number; up?: number; down?: number }[] | null;
}
interface Momentum {
  changeInConsensus?: Record<string, { period?: string; qtrMean?: number; yrMean?: number } | string | undefined>;
}

const revisions: CardDef = {
  id: 'equities.estimate-revisions',
  title: 'Estimate revisions',
  source: NASDAQ,
  description: 'Consensus EPS forecasts by quarter and fiscal year, the range of estimates, revisions over four weeks and the consensus a week and a month ago.',
  params: [SYMBOL],
  async run(ctx, params) {
    const symbol = symbolOf(params);
    const [f, m] = await Promise.all([
      nasdaqGet<{ quarterlyForecast?: Forecast; yearlyForecast?: Forecast }>(ctx, `/api/analyst/${api(symbol)}/earnings-forecast`, 3600),
      nasdaqGet<Momentum>(ctx, `/api/analyst/${api(symbol)}/estimate-momentum`, 3600).catch(() => null),
    ]);
    const toRows = (rows: Forecast['rows'], kind: string): Row[] =>
      (rows ?? []).map((r) => ({
        period: r.fiscalEnd,
        kind,
        consensus: r.consensusEPSForecast ?? null,
        high: r.highEPSForecast ?? null,
        low: r.lowEPSForecast ?? null,
        n: r.noOfEstimates ?? null,
        up: r.up ?? null,
        down: r.down ?? null,
        net: r.up != null && r.down != null ? r.up - r.down : null,
      }));
    const rows = [...toRows(f.quarterlyForecast?.rows, 'Quarter'), ...toRows(f.yearlyForecast?.rows, 'Fiscal year')];
    if (!rows.length) throw new SourceError(NASDAQ, `no earnings forecasts for ${symbol}`);
    const c = m?.changeInConsensus ?? {};
    const point = (k: string): { qtrMean?: number; yrMean?: number } => (typeof c[k] === 'object' ? (c[k] as { qtrMean?: number; yrMean?: number }) : {});
    const trend: Row[] = [
      { when: 'Current', qtr: point('currentData').qtrMean ?? null, yr: point('currentData').yrMean ?? null },
      { when: '1 week ago', qtr: point('weekData').qtrMean ?? null, yr: point('weekData').yrMean ?? null },
      { when: '1 month ago', qtr: point('monthData').qtrMean ?? null, yr: point('monthData').yrMean ?? null },
    ];
    const hasTrend = trend.some((t) => t.qtr !== null || t.yr !== null);
    return {
      blocks: [
        {
          kind: 'table',
          title: 'Consensus EPS forecasts',
          columns: [
            { key: 'period', label: 'Period end' },
            { key: 'kind', label: 'Type' },
            { key: 'consensus', label: 'Consensus', format: 'usd' },
            { key: 'high', label: 'High', format: 'usd' },
            { key: 'low', label: 'Low', format: 'usd' },
            { key: 'n', label: 'Estimates', format: 'int' },
            { key: 'up', label: 'Up 4w', format: 'int' },
            { key: 'down', label: 'Down 4w', format: 'int' },
            { key: 'net', label: 'Net', format: 'signed', digits: 0 },
          ],
          rows,
        },
        ...(hasTrend
          ? [{
              kind: 'table' as const,
              title: `Consensus trend (${String(c.fiscalQtrEndText ?? 'next quarter')}; ${String(c.fiscalYearEndText ?? 'fiscal year')})`,
              columns: [
                { key: 'when', label: 'As of' },
                { key: 'qtr', label: 'Quarter EPS', format: 'usd' as const },
                { key: 'yr', label: 'Fiscal year EPS', format: 'usd' as const },
              ],
              rows: trend,
            }]
          : []),
      ],
      sourceUrl: page(symbol, 'earnings'),
      notes: ['Forecasts compiled by Zacks Investment Research, published by Nasdaq. "Up" and "Down" count estimate revisions in the last four weeks.'],
    };
  },
};

/** Latest 8-K reporting results of operations (Item 2.02) and its press-release exhibit. */
export async function latestEarningsRelease(ctx: Ctx, cik: number): Promise<{ url: string; indexUrl: string; filed: string; reportDate: string; text: string }> {
  const sub = await submissions(ctx, cik);
  const candidates = sub.filings.filter((f) => f.form === '8-K' && /(^|,)2\.02(,|$)/.test(f.items)).slice(0, 3);
  if (!candidates.length) throw new SourceError(SEC, 'no recent Form 8-K with Item 2.02 (results of operations)');
  for (const f of candidates) {
    const docs = await filingDocs(ctx, cik, f.accession);
    const ex = docs.find((d) => /^EX-99\.1$/i.test(d.type)) ?? docs.find((d) => /^EX-99/i.test(d.type));
    if (!ex) continue;
    const html = await ctx.http.text(ex.url, { source: SEC, ttl: 21_600 });
    // EDGAR wraps each document in an SGML header (<TYPE>, <SEQUENCE>, <FILENAME>) that ends at <TEXT>.
    return { url: ex.url, indexUrl: filingIndexUrl(cik, f.accession), filed: f.filingDate, reportDate: f.reportDate, text: htmlToText(html.replace(/^[\s\S]{0,600}?<TEXT>/i, '')) };
  }
  throw new SourceError(SEC, 'the latest earnings 8-K has no Exhibit 99 press release');
}

const MAX_TEXT = 14_000;

const earningsRelease: CardDef = {
  id: 'equities.earnings-release',
  title: 'Earnings press release (8-K Exhibit 99.1)',
  source: SEC,
  description: 'Text of the press release attached to the latest Form 8-K that reports results of operations.',
  params: [SYMBOL],
  async run(ctx, params) {
    const symbol = symbolOf(params);
    const reg = await cikFor(ctx, symbol);
    const r = await latestEarningsRelease(ctx, reg.cik);
    const cut = r.text.length > MAX_TEXT;
    return {
      blocks: [
        { kind: 'stats', items: [{ label: 'Company', value: reg.title }, { label: 'Filed', value: r.filed }, { label: 'Event date', value: usDate(r.reportDate) }, { label: 'Length', value: r.text.length, format: 'int' }] },
        { kind: 'text', title: 'Exhibit 99.1', text: cut ? `${r.text.slice(0, MAX_TEXT)}\n\n[...]` : r.text },
      ],
      sourceUrl: r.url,
      asOf: r.filed,
      notes: [cut ? `Showing the first ${MAX_TEXT.toLocaleString('en-US')} of ${r.text.length.toLocaleString('en-US')} characters; open the link for the full release and its tables.` : 'Full text of the exhibit; tables are flattened to text.', `Filing index: ${r.indexUrl}`],
    };
  },
};

export const estimateCards: CardDef[] = [earnings, surpriseHistory, revisions, earningsRelease];
