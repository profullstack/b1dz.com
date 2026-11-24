/** U.S. Economy: nowcasts, housing and regional Fed business surveys. */
import { csvObjects, firstOf, num } from '../../http.js';
import { fredChart, fredSeries } from '../../lib/fred.js';
import { SourceError, type Block, type CardDef, type DashboardDef, type Row } from '../../types.js';
import { RANGE_CHOICES, rangeStartMs, type Point } from './data.js';
import { parseFeed } from './rss.js';

export interface GdpNowEstimate {
  /** ms epoch of the update. */
  t: number;
  /** e.g. "2026 Q4". */
  quarter: string;
  estimate: number;
}

const ORDINAL: Record<string, number> = { first: 1, second: 2, third: 3, fourth: 4 };

/** Estimates from the Atlanta Fed's GDPNow update feed, oldest first. Each item states the estimate in a sentence. */
export function parseGdpNow(xml: string): GdpNowEstimate[] {
  const out: GdpNowEstimate[] = [];
  for (const it of parseFeed(xml).items) {
    if (it.date === null) continue;
    const m = /in the (first|second|third|fourth) quarter of (\d{4}) is (-?\d+(?:\.\d+)?) percent/i.exec(it.summary);
    if (!m) continue;
    out.push({ t: it.date, quarter: `${m[2]} Q${ORDINAL[m[1].toLowerCase()]}`, estimate: Number(m[3]) });
  }
  return out.sort((a, b) => a.t - b.t);
}

const gdpNow: CardDef = {
  id: 'macro.us-gdpnow',
  title: 'GDPNow',
  source: 'Federal Reserve Bank of Atlanta',
  description: "The Atlanta Fed's running estimate of current-quarter real GDP growth.",
  async run(ctx) {
    const got = await firstOf<{ estimates: GdpNowEstimate[] }>([
      {
        name: 'Federal Reserve Bank of Atlanta',
        run: async () => {
          const xml = await ctx.http.text('https://www.atlantafed.org/rss/GDPNow', { source: 'Atlanta Fed', ttl: 1800 });
          const estimates = parseGdpNow(xml);
          if (!estimates.length) throw new SourceError('Atlanta Fed', 'no estimates in the GDPNow feed');
          return { estimates };
        },
      },
      {
        name: 'FRED',
        run: async () => {
          const s = await fredSeries(ctx, 'GDPNOW', { start: `${ctx.now().getUTCFullYear() - 2}-01-01` });
          return {
            estimates: s.points.map(([t, v]) => {
              const d = new Date(t);
              return { t, quarter: `${d.getUTCFullYear()} Q${Math.floor(d.getUTCMonth() / 3) + 1}`, estimate: v };
            }),
          };
        },
      },
    ]);
    const all = got.value.estimates;
    const last = all[all.length - 1];
    const sameQuarter = all.filter((e) => e.quarter === last.quarter);
    const prev = sameQuarter.length > 1 ? sameQuarter[sameQuarter.length - 2] : undefined;
    const fromFeed = got.source !== 'FRED';
    const blocks: Block[] = [
      {
        kind: 'stats',
        items: [
          { label: `Real GDP growth, ${last.quarter}`, value: last.estimate, format: 'signedPct', digits: 1 },
          { label: 'Updated', value: new Date(last.t).toISOString().slice(0, 10) },
          { label: 'Previous estimate', value: prev?.estimate ?? null, format: 'signedPct', digits: 1 },
          { label: 'Change', value: prev ? last.estimate - prev.estimate : null, format: 'signed', digits: 1 },
        ],
      },
    ];
    if (all.length > 1) blocks.push({ kind: 'chart', title: fromFeed ? 'GDPNow estimate by update' : 'GDPNow final estimate by quarter', xType: 'time', series: [{ name: 'GDPNow', points: all.map((e) => [e.t, e.estimate]) }], yFormat: 'pct', yDigits: 1 });
    blocks.push({
      kind: 'table',
      columns: [{ key: 'date', label: 'Update', format: 'date' }, { key: 'quarter', label: 'Quarter' }, { key: 'estimate', label: 'Estimate', format: 'signedPct', digits: 1 }],
      rows: [...all].reverse().slice(0, 20).map((e) => ({ date: e.t, quarter: e.quarter, estimate: e.estimate })),
    });
    const notes = ['Seasonally adjusted annual rate. A model nowcast, not an official forecast of the Atlanta Fed.', ...got.skipped];
    if (!fromFeed) notes.push('FRED carries one value per quarter (the latest estimate for that quarter).');
    return { blocks, source: got.source, sourceUrl: 'https://www.atlantafed.org/research-and-data/data/gdpnow', asOf: new Date(last.t).toISOString().slice(0, 10), notes };
  },
};

interface FusionChart {
  chart?: { subcaption?: string; _comment?: string };
  categories?: { category?: { label?: string; vline?: string }[] }[];
  dataset?: { seriesname?: string; data?: { value?: string }[] }[];
}

export interface Nowcast {
  /** "2026:Q4" */
  quarter: string;
  series: { name: string; points: Point[] }[];
}

/**
 * One quarter of the Cleveland Fed inflation nowcast chart file. Dates are
 * "MM/DD" labels; marker entries (`vline`) carry no data point. The year is
 * the quarter's year, moving forward when the month wraps past December.
 */
export function parseNowcastQuarter(chart: FusionChart): Nowcast | null {
  const quarter = chart.chart?.subcaption ?? '';
  const qm = /^(\d{4}):Q([1-4])$/.exec(quarter);
  if (!qm) return null;
  let year = Number(qm[1]);
  let lastMonth = 0;
  const dates: number[] = [];
  for (const c of chart.categories?.[0]?.category ?? []) {
    if (c.vline) continue;
    const m = /^(\d{1,2})\/(\d{1,2})$/.exec(c.label ?? '');
    if (!m) {
      dates.push(NaN);
      continue;
    }
    const month = Number(m[1]);
    if (lastMonth && month < lastMonth - 6) year += 1;
    lastMonth = month;
    dates.push(Date.UTC(year, month - 1, Number(m[2])));
  }
  const series = (chart.dataset ?? []).map((d) => {
    const points: Point[] = [];
    (d.data ?? []).forEach((v, i) => {
      const value = v.value === undefined || v.value === '' ? NaN : Number(v.value);
      if (Number.isFinite(value) && Number.isFinite(dates[i])) points.push([dates[i], value]);
    });
    return { name: (d.seriesname ?? '').replace(/\s+Inflation$/i, '').trim(), points };
  });
  return { quarter, series: series.filter((s) => s.name && s.points.length) };
}

const inflationNowcast: CardDef = {
  id: 'macro.us-inflation-nowcast',
  title: 'Inflation Nowcast',
  source: 'Federal Reserve Bank of Cleveland',
  description: "The Cleveland Fed's daily nowcast of quarterly CPI and PCE inflation, headline and core.",
  async run(ctx) {
    const body = await ctx.http.json<FusionChart[]>('https://www.clevelandfed.org/-/media/files/webcharts/inflationnowcasting/nowcast_quarter.json', { source: 'Cleveland Fed', ttl: 3600, timeoutMs: 45_000 });
    if (!Array.isArray(body) || !body.length) throw new SourceError('Cleveland Fed', 'unexpected nowcast file');
    const quarters = body.slice(-2).map(parseNowcastQuarter).filter((q): q is Nowcast => q !== null && q.series.length > 0);
    const current = quarters[quarters.length - 1];
    if (!current) throw new SourceError('Cleveland Fed', 'no nowcast series in the file');
    const lastT = Math.max(...current.series.map((s) => s.points[s.points.length - 1][0]));
    const rows: Row[] = [];
    for (const q of [...quarters].reverse()) {
      const row: Row = { quarter: q.quarter.replace(':', ' '), asOf: new Date(Math.max(...q.series.map((s) => s.points[s.points.length - 1][0]))).toISOString().slice(0, 10) };
      for (const s of q.series) row[s.name] = s.points[s.points.length - 1][1];
      rows.push(row);
    }
    const names = current.series.map((s) => s.name);
    return {
      blocks: [
        { kind: 'stats', title: `${current.quarter.replace(':', ' ')}, quarterly annualized`, items: current.series.map((s) => ({ label: s.name, value: s.points[s.points.length - 1][1], format: 'pct' as const, digits: 2 })) },
        { kind: 'chart', title: `Nowcast for ${current.quarter.replace(':', ' ')} by day`, xType: 'time', series: current.series, yFormat: 'pct', yDigits: 2 },
        { kind: 'table', columns: [{ key: 'quarter', label: 'Quarter' }, ...names.map((n) => ({ key: n, label: n, format: 'pct' as const, digits: 2 })), { key: 'asOf', label: 'Last nowcast' }], rows },
      ],
      sourceUrl: 'https://www.clevelandfed.org/indicators-and-data/inflation-nowcasting',
      asOf: new Date(lastT).toISOString().slice(0, 10),
      notes: ['Percent change over the quarter at an annual rate. Model nowcasts that update daily with oil and gasoline prices; not official forecasts of the Cleveland Fed.'],
    };
  },
};

/** Freddie Mac survey history: date as M/D/YYYY, then the 30-year and 15-year average rates. */
export function parsePmms(text: string): { fixed30: Point[]; fixed15: Point[] } {
  const fixed30: Point[] = [];
  const fixed15: Point[] = [];
  for (const r of csvObjects(text)) {
    const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(r.date ?? '');
    if (!m) continue;
    const t = Date.UTC(Number(m[3]), Number(m[1]) - 1, Number(m[2]));
    const a = num(r.pmms30);
    const b = num(r.pmms15);
    if (a !== null) fixed30.push([t, a]);
    if (b !== null) fixed15.push([t, b]);
  }
  fixed30.sort((x, y) => x[0] - y[0]);
  fixed15.sort((x, y) => x[0] - y[0]);
  return { fixed30, fixed15 };
}

const mortgage: CardDef = {
  id: 'macro.us-mortgage-rates',
  title: 'Mortgage Rates',
  source: 'Freddie Mac',
  description: 'Weekly average 30-year and 15-year fixed mortgage rates from the Primary Mortgage Market Survey.',
  params: [{ name: 'range', label: 'Range', default: '5Y', choices: RANGE_CHOICES }],
  async run(ctx, p) {
    const text = await ctx.http.text('https://www.freddiemac.com/pmms/docs/PMMS_history.csv', { source: 'Freddie Mac', ttl: 21600 });
    const { fixed30, fixed15 } = parsePmms(text);
    if (!fixed30.length) throw new SourceError('Freddie Mac', 'no rates in the survey file');
    const from = rangeStartMs(p.range, ctx.now(), '5Y');
    const last = fixed30[fixed30.length - 1];
    const at = (pts: Point[], back: number): number | null => (pts.length > back ? pts[pts.length - 1 - back][1] : null);
    const row = (label: string, pts: Point[]): Row => {
      const now = at(pts, 0);
      const d = (back: number): number | null => {
        const then = at(pts, back);
        return now !== null && then !== null ? (now - then) * 100 : null;
      };
      return { product: label, rate: now, week: d(1), month: d(4), year: d(52) };
    };
    return {
      blocks: [
        { kind: 'chart', title: 'Average mortgage rate, %', xType: 'time', series: [{ name: '30-year fixed', points: fixed30.filter(([t]) => t >= from) }, { name: '15-year fixed', points: fixed15.filter(([t]) => t >= from) }], yFormat: 'pct', yDigits: 2 },
        {
          kind: 'table',
          columns: [{ key: 'product', label: 'Loan' }, { key: 'rate', label: 'Rate', format: 'pct', digits: 2 }, { key: 'week', label: '1W chg', format: 'bp' }, { key: 'month', label: '4W chg', format: 'bp' }, { key: 'year', label: '52W chg', format: 'bp' }],
          rows: [row('30-year fixed', fixed30), row('15-year fixed', fixed15)],
        },
      ],
      sourceUrl: 'https://www.freddiemac.com/pmms',
      asOf: new Date(last[0]).toISOString().slice(0, 10),
      notes: ['Weekly survey, published on Thursdays. Rates are averages for conforming loans; fees and points are not included.'],
    };
  },
};

const HOUSING_TITLES = /residential|construction spending|home|housing|vacanc/i;

const censusIndicators: CardDef = {
  id: 'macro.us-census-indicators',
  title: 'Census Economic Indicators',
  source: 'U.S. Census Bureau',
  description: 'The latest reading of each Census Bureau indicator: housing starts and permits, new home sales, construction spending, retail sales, durable goods, trade and more.',
  params: [{ name: 'query', label: 'Filter', default: '', hint: 'word in the indicator name, e.g. residential; "housing" shows the housing set; empty shows all' }],
  async run(ctx, p) {
    const xml = await ctx.http.text('https://www.census.gov/economic-indicators/indicator.xml', { source: 'Census Bureau', ttl: 3600 });
    const items = parseFeed(xml).items;
    if (!items.length) throw new SourceError('Census Bureau', 'the indicator feed has no items');
    const q = (p.query ?? '').trim().toLowerCase();
    const picked = !q ? items : q === 'housing' ? items.filter((i) => HOUSING_TITLES.test(i.title)) : items.filter((i) => i.title.toLowerCase().includes(q));
    if (!picked.length) throw new SourceError('Census Bureau', `no indicator matches "${p.query}"`);
    const rows: Row[] = picked
      .sort((a, b) => (b.date ?? 0) - (a.date ?? 0))
      .map((i) => ({ indicator: i.title, released: i.date, summary: i.summary, link: i.link }));
    return {
      blocks: [{ kind: 'table', columns: [{ key: 'indicator', label: 'Indicator', maxWidth: 34 }, { key: 'released', label: 'Released', format: 'date' }, { key: 'summary', label: 'Latest reading', maxWidth: 120 }, { key: 'link', label: 'Link', maxWidth: 40 }], rows }],
      sourceUrl: 'https://www.census.gov/economic-indicators/',
      asOf: rows[0]?.released ? new Date(rows[0].released as number).toISOString().slice(0, 10) : undefined,
      notes: ['Text of each release as the Census Bureau publishes it; (r) marks a revised figure and * a change that is not statistically significant.'],
    };
  },
};

const housingFred: CardDef = {
  id: 'macro.us-housing',
  title: 'Housing Starts, Permits and Home Prices',
  source: 'FRED',
  description: 'Housing starts and building permits (annual rate) and the Case-Shiller national home price index.',
  params: [{ name: 'range', label: 'Range', default: '10Y', choices: RANGE_CHOICES }],
  async run(ctx, p) {
    const start = new Date(rangeStartMs(p.range, ctx.now(), '10Y')).toISOString().slice(0, 10);
    const activity = await fredChart(ctx, [{ id: 'HOUST', name: 'Housing starts' }, { id: 'PERMIT', name: 'Building permits' }], { start, ttl: 21600, title: 'Thousands of units, seasonally adjusted annual rate', yFormat: 'int' });
    const blocks: Block[] = [activity.block];
    const notes: string[] = [];
    if (activity.missing.length) notes.push(`Not available: ${activity.missing.join(', ')}.`);
    let price: Point[] = [];
    try {
      price = (await fredSeries(ctx, 'CSUSHPISA', { start, ttl: 21600 })).points;
      blocks.push({ kind: 'chart', title: 'S&P CoreLogic Case-Shiller U.S. national home price index (Jan 2000 = 100)', xType: 'time', series: [{ name: 'Home price index', points: price }], yFormat: 'num', yDigits: 1 });
    } catch (e) {
      notes.push(`Home price index unavailable (${(e as Error).message}).`);
    }
    const rows: Row[] = [];
    const add = (label: string, pts: Point[], unit: string): void => {
      if (!pts.length) return;
      const last = pts[pts.length - 1];
      const prev = pts[pts.length - 2];
      const yearAgo = pts.length > 12 ? pts[pts.length - 13] : undefined;
      rows.push({ item: label, month: new Date(last[0]).toISOString().slice(0, 7), latest: last[1], unit, mom: prev ? ((last[1] - prev[1]) / prev[1]) * 100 : null, yoy: yearAgo ? ((last[1] - yearAgo[1]) / yearAgo[1]) * 100 : null });
    };
    for (const s of activity.block.series) add(s.name, s.points, 'thousand units, annual rate');
    add('Case-Shiller national index', price, 'index');
    blocks.push({ kind: 'table', columns: [{ key: 'item', label: 'Series' }, { key: 'latest', label: 'Latest', format: 'num', digits: 1 }, { key: 'unit', label: 'Unit' }, { key: 'month', label: 'Month' }, { key: 'mom', label: '1M %', format: 'signedPct', digits: 1 }, { key: 'yoy', label: '12M %', format: 'signedPct', digits: 1 }], rows });
    notes.push('Starts and permits: U.S. Census Bureau via FRED. Home prices: S&P Dow Jones Indices via FRED, published with a two-month lag.');
    return { blocks, source: activity.source, sourceUrl: 'https://fred.stlouisfed.org/series/HOUST', asOf: rows[0]?.month as string | undefined, notes };
  },
};

interface Survey {
  name: string;
  bank: string;
  url: string;
  page: string;
  /** Column holding the survey month and how to read it. */
  date: (row: Record<string, string>) => number | null;
  /** Column suffix after the three-letter series code. */
  suffix: string;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** "Nov-26" -> ms epoch. Two-digit years from 60 up are the 1900s (the Philadelphia survey starts in 1968). */
export function parseMonYy(s: string): number | null {
  const m = /^([A-Za-z]{3})-(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const month = MONTHS.indexOf(m[1].toLowerCase());
  if (month < 0) return null;
  const yy = Number(m[2]);
  return Date.UTC(yy >= 60 ? 1900 + yy : 2000 + yy, month, 1);
}

const SURVEYS: Survey[] = [
  {
    name: 'Empire State Manufacturing Survey',
    bank: 'New York Fed',
    url: 'https://www.newyorkfed.org/medialibrary/media/Survey/Empire/data/ESMS_SeasonallyAdjusted_Diffusion.csv',
    page: 'https://www.newyorkfed.org/survey/empire/empiresurvey_overview',
    date: (r) => {
      const m = /^(\d{4})-(\d{2})/.exec(r.surveyDate ?? '');
      return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, 1) : null;
    },
    suffix: 'DISA',
  },
  {
    name: 'Manufacturing Business Outlook Survey',
    bank: 'Philadelphia Fed',
    url: 'https://www.philadelphiafed.org/-/media/frbp/assets/surveys-and-data/mbos/historical-data/diffusion-indexes/bos_dif.csv',
    page: 'https://www.philadelphiafed.org/surveys-and-data/regional-economic-analysis/manufacturing-business-outlook-survey',
    date: (r) => parseMonYy(r.DATE ?? ''),
    suffix: '',
  },
];

/** Diffusion index codes shared by the New York and Philadelphia surveys. */
const SURVEY_FIELDS: { code: string; key: string; label: string }[] = [
  { code: 'GAC', key: 'activity', label: 'General activity' },
  { code: 'NOC', key: 'orders', label: 'New orders' },
  { code: 'SHC', key: 'shipments', label: 'Shipments' },
  { code: 'NEC', key: 'employment', label: 'Employment' },
  { code: 'PPC', key: 'paid', label: 'Prices paid' },
  { code: 'PRC', key: 'received', label: 'Prices received' },
  { code: 'GAF', key: 'outlook', label: '6M outlook' },
];

export interface SurveyMonth {
  t: number;
  values: Record<string, number | null>;
}

export function parseSurvey(text: string, survey: Pick<Survey, 'date' | 'suffix'>): SurveyMonth[] {
  const out: SurveyMonth[] = [];
  for (const r of csvObjects(text)) {
    const t = survey.date(r);
    if (t === null) continue;
    const values: Record<string, number | null> = {};
    for (const f of SURVEY_FIELDS) values[f.key] = num(r[`${f.code}${survey.suffix}`]);
    if (values.activity === null) continue;
    out.push({ t, values });
  }
  return out.sort((a, b) => a.t - b.t);
}

const regionalFed: CardDef = {
  id: 'macro.us-regional-fed',
  title: 'Regional Fed Manufacturing Surveys',
  source: 'New York Fed, Philadelphia Fed',
  description: 'Headline and component diffusion indexes from the New York (Empire State) and Philadelphia Fed manufacturing surveys.',
  params: [{ name: 'range', label: 'Range', default: '5Y', choices: RANGE_CHOICES }],
  async run(ctx, p) {
    const from = rangeStartMs(p.range, ctx.now(), '5Y');
    const got = await Promise.allSettled(SURVEYS.map(async (s) => parseSurvey(await ctx.http.text(s.url, { source: s.bank, ttl: 21600 }), s)));
    const rows: Row[] = [];
    const lines: { name: string; points: Point[] }[] = [];
    const notes: string[] = [];
    const answered: string[] = [];
    let asOf = 0;
    got.forEach((g, i) => {
      const s = SURVEYS[i];
      if (g.status !== 'fulfilled' || !g.value.length) {
        notes.push(`${s.bank} survey unavailable (${g.status === 'rejected' ? (g.reason as Error).message : 'no rows'}).`);
        return;
      }
      answered.push(s.bank);
      const last = g.value[g.value.length - 1];
      const prev = g.value[g.value.length - 2];
      asOf = Math.max(asOf, last.t);
      rows.push({ survey: s.bank, month: new Date(last.t).toISOString().slice(0, 7), ...last.values, prior: prev?.values.activity ?? null });
      lines.push({ name: s.bank, points: g.value.filter((m) => m.t >= from).map((m) => [m.t, m.values.activity as number]) });
    });
    if (!rows.length) throw new SourceError('Regional Fed surveys', notes.join(' '));
    notes.unshift('Diffusion indexes, seasonally adjusted: the share of firms reporting an increase minus the share reporting a decrease. Above zero means expansion.');
    notes.push('The Richmond, Kansas City and Dallas Feds publish their survey history only as spreadsheets, and other districts run no monthly manufacturing survey, so they are not shown.');
    return {
      blocks: [
        { kind: 'chart', title: 'General business activity', xType: 'time', series: lines, yFormat: 'signed', yDigits: 1 },
        {
          kind: 'table',
          columns: [
            { key: 'survey', label: 'Survey' },
            { key: 'month', label: 'Month' },
            { key: 'activity', label: 'General activity', format: 'signed', digits: 1 },
            { key: 'prior', label: 'Prior', format: 'signed', digits: 1 },
            ...SURVEY_FIELDS.slice(1).map((f) => ({ key: f.key, label: f.label, format: 'signed' as const, digits: 1 })),
          ],
          rows,
        },
      ],
      source: answered.join(', '),
      sourceUrl: SURVEYS[0].page,
      asOf: new Date(asOf).toISOString().slice(0, 7),
      notes,
    };
  },
};

export const usActivityCards: CardDef[] = [gdpNow, inflationNowcast, mortgage, censusIndicators, housingFred, regionalFed];

export const usEconomyDashboard: DashboardDef = {
  id: 'us-economy',
  title: 'U.S. Economy',
  group: 'Macro & Economy',
  tabs: [
    { id: 'nowcasts', title: 'Nowcasts', cards: ['macro.us-gdpnow', 'macro.us-inflation-nowcast'] },
    { id: 'prices', title: 'Prices', cards: ['macro.us-cpi', 'macro.us-ppi'] },
    { id: 'labor', title: 'Labor', cards: ['macro.us-labor'] },
    { id: 'housing', title: 'Housing & CRE', cards: ['macro.us-mortgage-rates', 'macro.us-census-indicators', 'macro.us-housing'] },
    { id: 'surveys', title: 'Business surveys', cards: ['macro.us-regional-fed'] },
  ],
};
