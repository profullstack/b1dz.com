/** Agriculture & Food > Balances and Farm data. */
import { firstOf, num } from '../../http.js';
import { pctChange } from '../../format.js';
import { SourceError, type CardDef, type Ctx, type Row } from '../../types.js';
import { monthsBack, valueAt, ymd, type Point } from './util.js';

// ---------------------------------------------------------------- USDA PSD

const PSD = 'USDA FAS (PSD)';
const PSD_URL = 'https://apps.fas.usda.gov/psdonline/app/index.html';

export const PSD_COMMODITIES = {
  corn: { code: '0440000', name: 'Corn' },
  wheat: { code: '0410000', name: 'Wheat' },
  soybeans: { code: '2222000', name: 'Soybeans' },
  rice: { code: '0422110', name: 'Rice (milled)' },
} as const;

type PsdKey = keyof typeof PSD_COMMODITIES;

/** PSD attribute ids for the lines of a supply-and-demand balance. */
const ATTR = { area: 4, beginning: 20, production: 28, imports: 57, supply: 86, exports: 88, consumption: 125, ending: 176, yield: 184 } as const;

export interface Balance {
  marketYear: number;
  /** Month of the WASDE estimate (1-12) and its calendar year. */
  month: number | null;
  year: number | null;
  /** Thousand tonnes, except area (thousand hectares) and yield (tonnes per hectare). */
  values: Partial<Record<keyof typeof ATTR, number>>;
  /** Ending stocks as a percent of domestic consumption. */
  stocksToUse: number | null;
}

/** Rows of `/api/psd/commodity/{code}/world/year/{year}`: one per attribute, for the latest estimate of that marketing year. */
export function parsePsdWorld(body: unknown, marketYear: number): Balance {
  if (!Array.isArray(body)) throw new SourceError(PSD, 'unexpected response');
  const values: Balance['values'] = {};
  let month: number | null = null;
  let year: number | null = null;
  for (const r of body as Record<string, unknown>[]) {
    const id = num(r.attributeId);
    const v = num(r.value);
    if (id === null || v === null) continue;
    const name = (Object.keys(ATTR) as (keyof typeof ATTR)[]).find((k) => ATTR[k] === id);
    if (!name) continue;
    values[name] = v;
    month = num(String(r.month ?? '')) ?? month;
    year = num(String(r.calendarYear ?? '')) ?? year;
  }
  if (values.production === undefined) throw new SourceError(PSD, `no world balance for marketing year ${marketYear}`);
  const use = values.consumption;
  return { marketYear, month, year, values, stocksToUse: values.ending !== undefined && use ? (values.ending / use) * 100 : null };
}

/** "2026/27" for PSD marketing year 2026. */
export function marketYearLabel(my: number): string {
  return `${my}/${String((my + 1) % 100).padStart(2, '0')}`;
}

/** The marketing year the USDA is currently projecting: the new one is introduced each May. */
export function currentMarketYear(now: Date): number {
  return now.getUTCMonth() >= 4 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
}

async function psdWorld(ctx: Ctx, key: PsdKey, marketYear: number): Promise<Balance> {
  const url = (k: string): string => `https://api.fas.usda.gov/api/psd/commodity/${PSD_COMMODITIES[key].code}/world/year/${marketYear}?api_key=${encodeURIComponent(k)}`;
  const get = (k: string): Promise<unknown> => ctx.http.json<unknown>(url(k), { source: PSD, ttl: 21_600, timeoutMs: 30_000 });
  // The FAS API is on api.data.gov: a user's api.data.gov key (the Congress.gov key is one) lifts the demo limit.
  const own = ctx.key('CONGRESS');
  const { value } = await firstOf([
    ...(own ? [{ name: 'api.data.gov key', run: () => get(own) }] : []),
    { name: 'DEMO_KEY', run: () => get('DEMO_KEY') },
  ]);
  return parsePsdWorld(value, marketYear);
}

const PSD_NOTE =
  'USDA Production, Supply and Distribution database: world totals as of the latest monthly WASDE. Uses the shared api.data.gov demo key (about ten requests an hour per address) unless an api.data.gov key is configured (the CONGRESS key is one). World exports and imports differ because marketing years differ by country.';

const mt = (v: number | undefined): number | null => (v === undefined ? null : v / 1000);

const worldBalances: CardDef = {
  id: 'agri.world-balances',
  title: 'World grain and oilseed balances (WASDE)',
  source: PSD,
  description: 'World production, consumption, trade, ending stocks and stocks-to-use for corn, wheat, soybeans and rice in the current marketing year.',
  async run(ctx) {
    const my = currentMarketYear(ctx.now());
    const keys = Object.keys(PSD_COMMODITIES) as PsdKey[];
    const rows: Row[] = [];
    const failed: string[] = [];
    let est: Balance | undefined;
    for (const k of keys) {
      try {
        const b = await psdWorld(ctx, k, my);
        est = est ?? b;
        rows.push({
          name: PSD_COMMODITIES[k].name,
          production: mt(b.values.production),
          consumption: mt(b.values.consumption),
          exports: mt(b.values.exports),
          beginning: mt(b.values.beginning),
          ending: mt(b.values.ending),
          change: b.values.ending !== undefined && b.values.beginning !== undefined ? (b.values.ending - b.values.beginning) / 1000 : null,
          stu: b.stocksToUse,
        });
      } catch (e) {
        failed.push(`${PSD_COMMODITIES[k].name} (${(e as Error).message.replace(/^[^:]+:\s*/, '')})`);
      }
    }
    if (!rows.length) throw new SourceError(PSD, failed[0] ?? 'no balances returned');
    return {
      blocks: [
        {
          kind: 'chart',
          title: `Stocks-to-use, ${marketYearLabel(my)}, percent`,
          xType: 'category',
          style: 'bar',
          categories: rows.map((r) => String(r.name)),
          yFormat: 'pct',
          yDigits: 1,
          series: [{ name: 'Stocks-to-use', points: rows.map((r, i) => [i, (r.stu as number | null) ?? 0] as [number, number]) }],
        },
        {
          kind: 'table',
          title: `World, marketing year ${marketYearLabel(my)}, million tonnes`,
          columns: [
            { key: 'name', label: 'Commodity' },
            { key: 'production', label: 'Production', format: 'num', digits: 1 },
            { key: 'consumption', label: 'Consumption', format: 'num', digits: 1 },
            { key: 'exports', label: 'Exports', format: 'num', digits: 1 },
            { key: 'beginning', label: 'Beginning stocks', format: 'num', digits: 1 },
            { key: 'ending', label: 'Ending stocks', format: 'num', digits: 1 },
            { key: 'change', label: 'Stock change', format: 'signed', digits: 1 },
            { key: 'stu', label: 'Stocks-to-use', format: 'pct', digits: 1 },
          ],
          rows,
        },
      ],
      sourceUrl: PSD_URL,
      asOf: est?.year && est.month ? `${est.year}-${String(est.month).padStart(2, '0')}` : undefined,
      notes: [PSD_NOTE, ...(failed.length ? [`No data for: ${failed.join('; ')}`] : [])],
    };
  },
};

const balanceHistory: CardDef = {
  id: 'agri.balance-history',
  title: 'World balance sheet by marketing year',
  source: PSD,
  description: 'The world supply-and-demand balance for one crop across the last three marketing years.',
  params: [{ name: 'series', label: 'Commodity', default: 'corn', choices: Object.keys(PSD_COMMODITIES) }],
  async run(ctx, params) {
    const key = (Object.keys(PSD_COMMODITIES) as PsdKey[]).find((k) => k === (params.series ?? '').toLowerCase()) ?? 'corn';
    const my = currentMarketYear(ctx.now());
    const years = [my - 2, my - 1, my];
    const balances: Balance[] = [];
    for (const y of years) balances.push(await psdWorld(ctx, key, y));
    const line = (label: string, pick: (b: Balance) => number | null | undefined, unit = 'mt'): Row => {
      const row: Row = { name: label, unit };
      balances.forEach((b) => (row[`y${b.marketYear}`] = pick(b) ?? null));
      const a = pick(balances[1]);
      const c = pick(balances[2]);
      row.chg = unit === '%' ? (a != null && c != null ? c - a : null) : pctChange(c, a);
      return row;
    };
    const rows: Row[] = [
      line('Area harvested', (b) => mt(b.values.area), 'm ha'),
      line('Yield', (b) => b.values.yield, 't/ha'),
      line('Beginning stocks', (b) => mt(b.values.beginning)),
      line('Production', (b) => mt(b.values.production)),
      line('Imports', (b) => mt(b.values.imports)),
      line('Total supply', (b) => mt(b.values.supply)),
      line('Domestic consumption', (b) => mt(b.values.consumption)),
      line('Exports', (b) => mt(b.values.exports)),
      line('Ending stocks', (b) => mt(b.values.ending)),
      line('Stocks-to-use', (b) => b.stocksToUse, '%'),
    ];
    const last = balances[2];
    return {
      blocks: [
        {
          kind: 'chart',
          title: `${PSD_COMMODITIES[key].name}: world ending stocks, million tonnes`,
          xType: 'category',
          style: 'bar',
          categories: years.map(marketYearLabel),
          yFormat: 'num',
          yDigits: 1,
          series: [{ name: 'Ending stocks', points: balances.map((b, i) => [i, (b.values.ending ?? 0) / 1000] as [number, number]) }],
        },
        {
          kind: 'table',
          title: `${PSD_COMMODITIES[key].name}: world balance`,
          columns: [
            { key: 'name', label: 'Line' },
            { key: 'unit', label: 'Unit' },
            ...years.map((y) => ({ key: `y${y}`, label: marketYearLabel(y), format: 'num' as const, digits: 2 })),
            { key: 'chg', label: 'Latest chg', format: 'signedPct' as const, digits: 1 },
          ],
          rows,
          footnote: 'Latest chg: percent change on the previous marketing year (percentage points for stocks-to-use).',
        },
      ],
      sourceUrl: PSD_URL,
      asOf: last.year && last.month ? `${last.year}-${String(last.month).padStart(2, '0')}` : undefined,
      notes: [`${marketYearLabel(my)} is the USDA projection; earlier years are estimates that are still revised.`, PSD_NOTE],
    };
  },
};

// ---------------------------------------------------------------- BLS farm and food prices

const BLS = 'BLS';

const FARM_SERIES = [
  { id: 'WPU01', name: 'PPI: farm products' },
  { id: 'WPU012', name: 'PPI: grains' },
  { id: 'WPU013', name: 'PPI: slaughter livestock' },
  { id: 'WPU02', name: 'PPI: processed foods and feeds' },
  { id: 'CUSR0000SAF11', name: 'CPI: food at home' },
  { id: 'CUSR0000SEFV', name: 'CPI: food away from home' },
];

/** BLS public API response to points by series id (oldest first). Annual averages and missing values are skipped. */
export function parseBls(body: unknown): Map<string, Point[]> {
  const b = body as { status?: string; message?: string[]; Results?: { series?: { seriesID?: string; data?: { year?: string; period?: string; value?: string }[] }[] } };
  if (b?.status && b.status !== 'REQUEST_SUCCEEDED') throw new SourceError(BLS, (b.message ?? []).join(' ') || b.status);
  const out = new Map<string, Point[]>();
  for (const s of b?.Results?.series ?? []) {
    const pts: Point[] = [];
    for (const d of s.data ?? []) {
      const m = /^M(0[1-9]|1[0-2])$/.exec(d.period ?? '');
      const v = num(d.value ?? '');
      if (!m || v === null || !d.year) continue;
      pts.push([Date.UTC(+d.year, +m[1] - 1, 1), v]);
    }
    if (s.seriesID && pts.length) out.set(s.seriesID, pts.sort((x, y) => x[0] - y[0]));
  }
  return out;
}

const farmPrices: CardDef = {
  id: 'agri.farm-prices',
  title: 'U.S. farm and food price indexes',
  source: BLS,
  description: 'Producer prices received for farm products, grains and livestock beside consumer food prices, with yearly change.',
  async run(ctx) {
    const y = ctx.now().getUTCFullYear();
    const body = await ctx.http.json<unknown>('https://api.bls.gov/publicAPI/v1/timeseries/data/', {
      source: BLS,
      ttl: 21_600,
      method: 'POST',
      body: { seriesid: FARM_SERIES.map((s) => s.id), startyear: String(y - 5), endyear: String(y) },
    });
    const got = parseBls(body);
    if (!got.size) throw new SourceError(BLS, 'no series returned');
    const yoy = (pts: Point[]): Point[] =>
      pts.flatMap(([t, v]) => {
        const prev = pts.find((p) => p[0] === monthsBack(t, 12));
        return prev ? [[t, ((v - prev[1]) / prev[1]) * 100] as Point] : [];
      });
    let asOf = 0;
    const rows: Row[] = FARM_SERIES.filter((s) => got.has(s.id)).map((s) => {
      const pts = got.get(s.id) as Point[];
      const [t, last] = pts[pts.length - 1];
      asOf = Math.max(asOf, t);
      return {
        name: s.name,
        last,
        m1: pctChange(last, valueAt(pts, monthsBack(t, 1))),
        m3: pctChange(last, valueAt(pts, monthsBack(t, 3))),
        y1: pctChange(last, pts.find((p) => p[0] === monthsBack(t, 12))?.[1]),
        month: ymd(t).slice(0, 7),
      };
    });
    return {
      blocks: [
        {
          kind: 'chart',
          title: 'Change on a year earlier, percent',
          xType: 'time',
          yFormat: 'signedPct',
          yDigits: 1,
          series: [
            { name: 'Farm products (PPI)', points: yoy(got.get('WPU01') ?? []) },
            { name: 'Food at home (CPI)', points: yoy(got.get('CUSR0000SAF11') ?? []) },
          ].filter((s) => s.points.length),
        },
        {
          kind: 'table',
          columns: [
            { key: 'name', label: 'Index' },
            { key: 'last', label: 'Level', format: 'num', digits: 1 },
            { key: 'm1', label: '1M', format: 'signedPct', digits: 1 },
            { key: 'm3', label: '3M', format: 'signedPct', digits: 1 },
            { key: 'y1', label: '1Y', format: 'signedPct', digits: 1 },
            { key: 'month', label: 'Month' },
          ],
          rows,
        },
      ],
      sourceUrl: 'https://www.bls.gov/ppi/',
      asOf: ymd(asOf).slice(0, 7),
      notes: [
        'BLS producer price indexes (1982 = 100, not seasonally adjusted) and consumer price indexes (1982-84 = 100, seasonally adjusted). The keyless BLS API allows 25 requests a day per address. The gap between farm and retail food prices is the processing and distribution margin. A blank 1Y means the BLS published no index for the same month a year earlier.',
      ],
    };
  },
};

export const agriBalanceCards: CardDef[] = [worldBalances, balanceHistory];
export const agriFarmCards: CardDef[] = [farmPrices];
