/**
 * Sovereign yield curves from each country's official publisher, as tenor
 * series through time. Countries without a daily official source here fall
 * back to the OECD monthly 3-month and 10-year pair.
 */
import { parseCsv } from '../../http.js';
import { SourceError, type Ctx } from '../../types.js';
import {
  DAY,
  dayMs,
  ecbCsv,
  interpolate,
  sdmxSeries,
  sortPoints,
  tenorLabel,
  tenorYears,
  ymd,
  countryBy,
  type TenorSeries,
} from './util.js';

export interface CurveData {
  series: TenorSeries[];
  source: string;
  sourceUrl: string;
  /** What the yields are: par, zero-coupon spot, benchmark bond. */
  basis: string;
  notes: string[];
  /** How old an observation may be and still stand for a date (monthly sources need more). */
  maxStaleDays: number;
  frequency: 'daily' | 'monthly';
}

/** Countries with an official daily curve wired up. */
export const DAILY_CURVE_COUNTRIES = ['US', 'EA', 'GB', 'JP', 'CA', 'SE', 'BR'];

// ---------- United States: Treasury daily rate CSVs ----------

export type TreasuryType = 'daily_treasury_yield_curve' | 'daily_treasury_real_yield_curve' | 'daily_treasury_bill_rates';

export interface TreasuryTable {
  columns: string[];
  /** Oldest first. */
  rows: { date: string; values: (number | null)[] }[];
}

/** Treasury's rate CSV: a Date column (MM/DD/YYYY) and one column per maturity. */
export function parseTreasuryCsv(text: string): TreasuryTable {
  const rows = parseCsv(text);
  if (!rows.length) return { columns: [], rows: [] };
  const columns = rows[0].slice(1).map((c) => c.trim());
  const out: TreasuryTable['rows'] = [];
  for (const r of rows.slice(1)) {
    const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(r[0]?.trim() ?? '');
    if (!m) continue;
    const date = `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
    out.push({
      date,
      values: columns.map((_, i) => {
        const raw = (r[i + 1] ?? '').trim();
        const v = Number(raw);
        return raw === '' || !Number.isFinite(v) ? null : v;
      }),
    });
  }
  out.sort((a, b) => (a.date < b.date ? -1 : 1));
  return { columns, rows: out };
}

export async function treasuryYear(ctx: Ctx, type: TreasuryType, year: number): Promise<TreasuryTable> {
  const current = year >= ctx.now().getUTCFullYear();
  const url = `https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/${year}/all?type=${type}&field_tdr_date_value=${year}&page&_format=csv`;
  const text = await ctx.http.text(url, { source: 'U.S. Treasury', ttl: current ? 900 : 86_400, timeoutMs: 75_000 });
  const table = parseTreasuryCsv(text);
  if (!table.rows.length && current && ctx.now().getUTCMonth() > 0) throw new SourceError('U.S. Treasury', `no rows in the ${year} ${type} file`);
  return table;
}

/** Several year files merged into one table (columns are the union; older files lack the newer maturities). */
export async function treasuryTable(ctx: Ctx, type: TreasuryType, years: number[]): Promise<TreasuryTable> {
  const uniq = [...new Set(years)].sort((a, b) => a - b);
  const tables: TreasuryTable[] = [];
  for (const y of uniq) tables.push(await treasuryYear(ctx, type, y));
  const columns: string[] = [];
  for (const t of [...tables].reverse()) for (const c of t.columns) if (!columns.includes(c)) columns.push(c);
  const rows: TreasuryTable['rows'] = [];
  for (const t of tables) {
    const idx = columns.map((c) => t.columns.indexOf(c));
    for (const r of t.rows) rows.push({ date: r.date, values: idx.map((i) => (i < 0 ? null : r.values[i])) });
  }
  return { columns, rows };
}

/** Table columns that are maturities, as tenor series sorted by maturity. */
export function tableToSeries(table: TreasuryTable): TenorSeries[] {
  const out: TenorSeries[] = [];
  table.columns.forEach((c, i) => {
    const years = tenorYears(c);
    if (years === null) return;
    const points: [string, number][] = [];
    for (const r of table.rows) {
      const v = r.values[i];
      if (v !== null) points.push([r.date, v]);
    }
    if (points.length) out.push({ label: tenorLabel(years), years, points });
  });
  return out.sort((a, b) => a.years - b.years);
}

/** The calendar years that hold the given dates (and the year before, for a date in early January). */
export function yearsFor(dates: string[]): number[] {
  const out = new Set<number>();
  for (const d of dates) {
    out.add(Number(d.slice(0, 4)));
    out.add(new Date(dayMs(d) - 10 * DAY).getUTCFullYear());
  }
  return [...out];
}

export function yearsBetween(start: string, end: string): number[] {
  const out: number[] = [];
  for (let y = Number(start.slice(0, 4)); y <= Number(end.slice(0, 4)); y++) out.push(y);
  return out;
}

async function usCurve(ctx: Ctx, dates: string[]): Promise<CurveData> {
  const table = await treasuryTable(ctx, 'daily_treasury_yield_curve', yearsFor(dates));
  return {
    series: tableToSeries(table),
    source: 'U.S. Treasury',
    sourceUrl: 'https://home.treasury.gov/resource-center/data-chart-center/interest-rates/TextView?type=daily_treasury_yield_curve',
    basis: 'par yields',
    notes: ['Treasury par yield curve rates (constant maturity), close of business.'],
    maxStaleDays: 10,
    frequency: 'daily',
  };
}

// ---------- Euro area: ECB yield curve ----------

export const ECB_TENORS = ['3M', '6M', '1Y', '2Y', '3Y', '5Y', '7Y', '10Y', '15Y', '20Y', '30Y'];

/** ECB yield-curve CSV rows to tenor series, split by issuer set (G_N_A = AAA, G_N_C = all issuers). */
export function parseEcbCurve(text: string): Map<string, TenorSeries[]> {
  const byKey = sdmxSeries(text, (r) => `${r.INSTRUMENT_FM}|${r.DATA_TYPE_FM}`);
  const out = new Map<string, TenorSeries[]>();
  for (const [k, points] of byKey) {
    const [issuer, type] = k.split('|');
    const years = tenorYears(type);
    if (years === null) continue;
    let list = out.get(issuer);
    if (!list) out.set(issuer, (list = []));
    list.push({ label: tenorLabel(years), years, points });
  }
  for (const list of out.values()) list.sort((a, b) => a.years - b.years);
  return out;
}

export async function ecbCurves(ctx: Ctx, start: string, issuers = 'G_N_A'): Promise<Map<string, TenorSeries[]>> {
  const key = `B.U2.EUR.4F.${issuers}.SV_C_YM.${ECB_TENORS.map((t) => `SR_${t}`).join('+')}`;
  const got = parseEcbCurve(await ecbCsv(ctx, 'YC', key, `startPeriod=${start}`));
  if (!got.size) throw new SourceError('ECB', 'the yield curve request returned no observations');
  return got;
}

async function eaCurve(ctx: Ctx, dates: string[]): Promise<CurveData> {
  const start = ymd(dayMs(dates.reduce((a, b) => (a < b ? a : b))) - 15 * DAY);
  const curves = await ecbCurves(ctx, start);
  return {
    series: curves.get('G_N_A') ?? [],
    source: 'ECB',
    sourceUrl: 'https://www.ecb.europa.eu/stats/financial_markets_and_interest_rates/euro_area_yield_curves/html/index.en.html',
    basis: 'zero-coupon spot rates',
    notes: ['ECB spot curve fitted to AAA-rated euro area central government bonds (Svensson model).'],
    maxStaleDays: 10,
    frequency: 'daily',
  };
}

// ---------- United Kingdom: Bank of England database ----------

const BOE_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Bank of England database CSV: DATE ("01 Oct 2026") then one column per series code. */
export function parseBoeCsv(text: string): Map<string, [string, number][]> {
  const rows = parseCsv(text);
  const out = new Map<string, [string, number][]>();
  if (rows.length < 2 || rows[0][0]?.trim().toUpperCase() !== 'DATE') return out;
  const codes = rows[0].slice(1).map((c) => c.trim());
  for (const c of codes) out.set(c, []);
  for (const r of rows.slice(1)) {
    const m = /^(\d{1,2}) (\w{3}) (\d{4})$/.exec(r[0]?.trim() ?? '');
    const mon = m ? BOE_MONTHS.indexOf(m[2]) : -1;
    if (!m || mon < 0) continue;
    const date = `${m[3]}-${String(mon + 1).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    codes.forEach((c, i) => {
      const raw = (r[i + 1] ?? '').trim();
      const v = Number(raw);
      if (raw !== '' && Number.isFinite(v)) out.get(c)?.push([date, v]);
    });
  }
  for (const [k, v] of out) out.set(k, sortPoints(v));
  return out;
}

export async function boeSeries(ctx: Ctx, codes: string[], start: string): Promise<Map<string, [string, number][]>> {
  const d = new Date(dayMs(start));
  const from = `${String(d.getUTCDate()).padStart(2, '0')}/${BOE_MONTHS[d.getUTCMonth()]}/${d.getUTCFullYear()}`;
  const url = `https://www.bankofengland.co.uk/boeapps/database/_iadb-fromshowcolumns.asp?csv.x=yes&Datefrom=${from}&Dateto=now&SeriesCodes=${codes.join(',')}&CSVF=TN&UsingCodes=Y`;
  const got = parseBoeCsv(await ctx.http.text(url, { source: 'Bank of England', ttl: 3600, timeoutMs: 30_000 }));
  if (![...got.values()].some((p) => p.length)) throw new SourceError('Bank of England', 'the database returned no observations');
  return got;
}

async function gbCurve(ctx: Ctx, dates: string[]): Promise<CurveData> {
  const start = ymd(dayMs(dates.reduce((a, b) => (a < b ? a : b))) - 15 * DAY);
  const got = await boeSeries(ctx, ['IUDSNPY', 'IUDMNPY', 'IUDLNPY'], start);
  const tenors: [string, number][] = [['IUDSNPY', 5], ['IUDMNPY', 10], ['IUDLNPY', 20]];
  return {
    series: tenors.map(([code, years]) => ({ label: tenorLabel(years), years, points: got.get(code) ?? [] })).filter((s) => s.points.length),
    source: 'Bank of England',
    sourceUrl: 'https://www.bankofengland.co.uk/statistics/yield-curves',
    basis: 'nominal par yields',
    notes: ['Bank of England publishes three points in its database (5, 10 and 20 years, British government nominal par yields); the full fitted curve is spreadsheet-only.'],
    maxStaleDays: 10,
    frequency: 'daily',
  };
}

// ---------- Japan: Ministry of Finance JGB curve ----------

/** MoF JGB CSV: a title line, a header "Date,1Y,2Y,...", rows "2026/11/2,1.671,...", "-" for no value. */
export function parseMofCsv(text: string): TenorSeries[] {
  const rows = parseCsv(text);
  const headAt = rows.findIndex((r) => r[0]?.trim() === 'Date');
  if (headAt < 0) return [];
  const cols = rows[headAt].slice(1).map((c) => c.trim());
  const series: TenorSeries[] = cols.map((c) => ({ label: c, years: tenorYears(c) ?? NaN, points: [] }));
  for (const r of rows.slice(headAt + 1)) {
    const m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(r[0]?.trim() ?? '');
    if (!m) continue;
    const date = `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
    series.forEach((s, i) => {
      const raw = (r[i + 1] ?? '').trim();
      const v = Number(raw);
      if (raw !== '' && raw !== '-' && Number.isFinite(v)) s.points.push([date, v]);
    });
  }
  return series.filter((s) => Number.isFinite(s.years) && s.points.length);
}

async function jpCurve(ctx: Ctx): Promise<CurveData> {
  const base = 'https://www.mof.go.jp/english/policy/jgbs/reference/interest_rate';
  const history = parseMofCsv(await ctx.http.text(`${base}/historical/jgbcme_all.csv`, { source: 'Japan MoF', ttl: 21_600, timeoutMs: 45_000 }));
  const month = parseMofCsv(await ctx.http.text(`${base}/jgbcme.csv`, { source: 'Japan MoF', ttl: 3600 }));
  if (!history.length && !month.length) throw new SourceError('Japan MoF', 'no rows in the JGB interest rate files');
  const labels = [...new Set([...history, ...month].map((s) => s.label))];
  const series = labels.map((label) => {
    const a = history.find((s) => s.label === label);
    const b = month.find((s) => s.label === label);
    return { label, years: (a ?? b)!.years, points: sortPoints([...(a?.points ?? []), ...(b?.points ?? [])]) };
  });
  return {
    series: series.sort((a, b) => a.years - b.years),
    source: 'Japan MoF',
    sourceUrl: 'https://www.mof.go.jp/english/policy/jgbs/reference/interest_rate/index.htm',
    basis: 'constant-maturity par yields',
    notes: ['Ministry of Finance JGB yields by constant maturity, semi-annual compounding.'],
    maxStaleDays: 10,
    frequency: 'daily',
  };
}

// ---------- Canada: Bank of Canada Valet ----------

export interface ValetGroup {
  observations?: Record<string, string | { v?: string }>[];
}

/** Valet group observations to [date, value] per series id. */
export function parseValet(body: ValetGroup): Map<string, [string, number][]> {
  const out = new Map<string, [string, number][]>();
  for (const o of body.observations ?? []) {
    const date = typeof o.d === 'string' ? o.d : '';
    if (!date) continue;
    for (const [k, cell] of Object.entries(o)) {
      if (k === 'd' || typeof cell === 'string') continue;
      const v = Number(cell.v);
      if (cell.v === undefined || cell.v === '' || !Number.isFinite(v)) continue;
      let list = out.get(k);
      if (!list) out.set(k, (list = []));
      list.push([date, v]);
    }
  }
  for (const [k, v] of out) out.set(k, sortPoints(v));
  return out;
}

async function caCurve(ctx: Ctx, dates: string[]): Promise<CurveData> {
  const start = ymd(dayMs(dates.reduce((a, b) => (a < b ? a : b))) - 30 * DAY);
  const get = async (group: string) =>
    parseValet(await ctx.http.json<ValetGroup>(`https://www.bankofcanada.ca/valet/observations/group/${group}/json?start_date=${start}`, { source: 'Bank of Canada', ttl: 3600, timeoutMs: 30_000 }));
  const bills = await get('tbill_all');
  const bonds = await get('bond_yields_benchmark');
  const map: [string, number, Map<string, [string, number][]>][] = [
    ['V80691303', 0.25, bills],
    ['V80691304', 0.5, bills],
    ['V80691305', 1, bills],
    ['BD.CDN.2YR.DQ.YLD', 2, bonds],
    ['BD.CDN.3YR.DQ.YLD', 3, bonds],
    ['BD.CDN.5YR.DQ.YLD', 5, bonds],
    ['BD.CDN.7YR.DQ.YLD', 7, bonds],
    ['BD.CDN.10YR.DQ.YLD', 10, bonds],
    ['BD.CDN.LONG.DQ.YLD', 30, bonds],
  ];
  const series = map.map(([id, years, src]) => ({ label: tenorLabel(years), years, points: src.get(id) ?? [] })).filter((s) => s.points.length);
  if (!series.length) throw new SourceError('Bank of Canada', 'Valet returned no bill or bond yields');
  return {
    series,
    source: 'Bank of Canada',
    sourceUrl: 'https://www.bankofcanada.ca/rates/interest-rates/canadian-bonds/',
    basis: 'treasury bill and benchmark bond yields',
    notes: ['Treasury bill yields (3M, 6M, 1Y) are published less often than the daily benchmark bond yields; the 30Y point is the long benchmark bond.'],
    maxStaleDays: 21,
    frequency: 'daily',
  };
}

// ---------- Sweden: Riksbank ----------

export interface RiksbankRow {
  seriesId?: string;
  date?: string;
  value?: number;
}

export function parseRiksbank(rows: RiksbankRow[]): Map<string, [string, number][]> {
  const out = new Map<string, [string, number][]>();
  for (const r of rows) {
    if (!r.seriesId || !r.date || typeof r.value !== 'number' || !Number.isFinite(r.value)) continue;
    let list = out.get(r.seriesId);
    if (!list) out.set(r.seriesId, (list = []));
    list.push([r.date, r.value]);
  }
  for (const [k, v] of out) out.set(k, sortPoints(v));
  return out;
}

async function seCurve(ctx: Ctx, dates: string[]): Promise<CurveData> {
  const end = ymd(ctx.now());
  const opts = { source: 'Riksbank', timeoutMs: 30_000 };
  const base = 'https://api.riksbank.se/swea/v1/Observations';
  // The open API allows five requests a minute and one year per group query:
  // bills and bonds for the last ~11 months, then bonds only around each older date.
  const get = async (group: number, from: string, to: string, ttl = 3600) =>
    parseRiksbank(await ctx.http.json<RiksbankRow[]>(`${base}/ByGroup/${group}/${from}/${to}`, { ...opts, ttl }));
  const recent = ymd(dayMs(end) - 350 * DAY);
  const bills = await get(6, recent, end);
  const bonds = await get(7, recent, end);
  for (const d of [...new Set(dates)].sort()) {
    if (d >= recent) continue;
    const older = await get(7, ymd(dayMs(d) - 12 * DAY), ymd(dayMs(d) + 2 * DAY), 21_600);
    for (const [id, points] of older) bonds.set(id, sortPoints([...points, ...(bonds.get(id) ?? [])]));
  }
  const map: [string, number, Map<string, [string, number][]>][] = [
    ['SETB1MBENCHC', 1 / 12, bills],
    ['SETB3MBENCH', 0.25, bills],
    ['SETB6MBENCH', 0.5, bills],
    ['SEGVB2YC', 2, bonds],
    ['SEGVB5YC', 5, bonds],
    ['SEGVB7YC', 7, bonds],
    ['SEGVB10YC', 10, bonds],
  ];
  const series = map.map(([id, years, src]) => ({ label: tenorLabel(years), years, points: src.get(id) ?? [] })).filter((s) => s.points.length);
  if (!series.length) throw new SourceError('Riksbank', 'no treasury bill or government bond observations');
  return {
    series,
    source: 'Riksbank',
    sourceUrl: 'https://www.riksbank.se/en-gb/statistics/interest-rates-and-exchange-rates/search-interest-rates-and-exchange-rates/',
    basis: 'treasury bill and government bond benchmark yields',
    notes: [
      'Swedish treasury bills (1M, 3M, 6M) and government bond benchmarks (2Y to 10Y) as published by the Riksbank.',
      'The Riksbank open API allows five requests a minute, so comparisons older than about eleven months cover the bonds only, and a quick reload can be refused (HTTP 429).',
    ],
    maxStaleDays: 10,
    frequency: 'daily',
  };
}

// ---------- Brazil: Tesouro Direto ----------

export const BR_TENORS = [1, 2, 3, 5, 7, 10];

/**
 * Tesouro Direto price/rate file (semicolon CSV, decimal comma, DD/MM/YYYY).
 * Fixed-rate bonds ("Tesouro Prefixado", with or without coupons) give each
 * day a set of [years to maturity, buy rate] points, which are interpolated
 * linearly onto standard tenors.
 */
export function parseTesouro(text: string, since: string, tenors = BR_TENORS): TenorSeries[] {
  const byDate = new Map<string, [number, number][]>();
  const iso = (s: string) => `${s.slice(6, 10)}-${s.slice(3, 5)}-${s.slice(0, 2)}`;
  let from = 0;
  while (from < text.length) {
    let to = text.indexOf('\n', from);
    if (to < 0) to = text.length;
    if (text.startsWith('Tesouro Prefixado', from)) {
      const f = text.slice(from, to).split(';');
      const date = iso(f[2] ?? '');
      const rate = Number((f[3] ?? '').replace(',', '.'));
      if (date >= since && Number.isFinite(rate) && rate > 0) {
        const years = (dayMs(iso(f[1] ?? '')) - dayMs(date)) / (365.25 * DAY);
        if (years > 0.05) {
          let list = byDate.get(date);
          if (!list) byDate.set(date, (list = []));
          list.push([years, rate]);
        }
      }
    }
    from = to + 1;
  }
  const series: TenorSeries[] = tenors.map((t) => ({ label: tenorLabel(t), years: t, points: [] }));
  for (const date of [...byDate.keys()].sort()) {
    const knots = byDate.get(date)!.sort((a, b) => a[0] - b[0]);
    series.forEach((s) => {
      const v = interpolate(knots, s.years);
      if (v !== null) s.points.push([date, Math.round(v * 1000) / 1000]);
    });
  }
  return series.filter((s) => s.points.length);
}

async function brCurve(ctx: Ctx, dates: string[]): Promise<CurveData> {
  const since = ymd(dayMs(dates.reduce((a, b) => (a < b ? a : b))) - 15 * DAY);
  const url =
    'https://www.tesourotransparente.gov.br/ckan/dataset/df56aa42-484a-4a59-8184-7676580c81e3/resource/796d2059-14e9-44e3-80c9-2d9e30b405c1/download/PrecoTaxaTesouroDireto.csv';
  const text = await ctx.http.text(url, { source: 'Tesouro Nacional', ttl: 21_600, timeoutMs: 90_000 });
  const series = parseTesouro(text, since);
  if (!series.length) throw new SourceError('Tesouro Nacional', 'no fixed-rate bond rows in the Tesouro Direto file');
  return {
    series,
    source: 'Tesouro Nacional',
    sourceUrl: 'https://www.tesourodireto.com.br/titulos/precos-e-taxas.htm',
    basis: 'fixed-rate bond buy rates, interpolated',
    notes: [
      'Tesouro Direto morning buy rates on fixed-rate federal bonds (Tesouro Prefixado, with and without coupons), interpolated linearly between the bonds on offer; tenors outside the offered maturities are left blank.',
      'The source file is about 15 MB, so the first load is slow.',
    ],
    maxStaleDays: 10,
    frequency: 'daily',
  };
}

// ---------- OECD monthly rates (every other country) ----------

export interface OecdRates {
  /** ISO-3 (EA20 for the euro area) -> series, periods as YYYY-MM. */
  long: Map<string, [string, number][]>;
  short: Map<string, [string, number][]>;
}

export function parseOecdRates(text: string): OecdRates {
  const all = sdmxSeries(text, (r) => `${r.MEASURE}|${r.REF_AREA}`);
  const long = new Map<string, [string, number][]>();
  const short = new Map<string, [string, number][]>();
  for (const [k, points] of all) {
    const [measure, area] = k.split('|');
    if (measure === 'IRLT') long.set(area, points);
    else if (measure === 'IR3TIB') short.set(area, points);
  }
  return { long, short };
}

/** OECD monthly long-term (10-year government bond) and 3-month interbank rates. `area` is ISO-3 or '' for all. */
export async function oecdRates(ctx: Ctx, area: string, opts: { start?: string; last?: number }): Promise<OecdRates> {
  const q = opts.start ? `startPeriod=${opts.start.slice(0, 7)}` : `lastNObservations=${opts.last ?? 13}`;
  const url = `https://sdmx.oecd.org/public/rest/data/OECD.SDD.STES,DSD_STES@DF_FINMARK,4.0/${area}.M.IRLT+IR3TIB.PA._Z._Z._Z._Z.N?${q}&format=csvfile`;
  const got = parseOecdRates(await ctx.http.text(url, { source: 'OECD', ttl: 21_600, timeoutMs: 45_000 }));
  if (!got.long.size && !got.short.size) throw new SourceError('OECD', `no monthly interest rates for ${area || 'any country'}`);
  return got;
}

async function oecdCurve(ctx: Ctx, iso2: string, dates: string[]): Promise<CurveData> {
  const c = countryBy(iso2);
  if (!c) throw new SourceError('OECD', `unknown country code ${iso2}`);
  const start = ymd(dayMs(dates.reduce((a, b) => (a < b ? a : b))) - 62 * DAY);
  const got = await oecdRates(ctx, c.iso3, { start });
  const month = (p: [string, number][]): [string, number][] => p.map(([d, v]) => [`${d}-01`, v]);
  const series: TenorSeries[] = [];
  const s = got.short.get(c.iso3);
  const l = got.long.get(c.iso3);
  if (s?.length) series.push({ label: '3M', years: 0.25, points: month(s) });
  if (l?.length) series.push({ label: '10Y', years: 10, points: month(l) });
  if (!series.length) throw new SourceError('OECD', `no monthly interest rates for ${c.name}`);
  return {
    series,
    source: 'OECD',
    sourceUrl: 'https://data-explorer.oecd.org/vis?df[ds]=dsDisseminateFinalDMZ&df[id]=DSD_STES%40DF_FINMARK&df[ag]=OECD.SDD.STES',
    basis: 'monthly averages',
    notes: [
      `No official daily curve is wired up for ${c.name}: these are OECD monthly averages (3-month interbank rate and 10-year government bond yield), dated to the first of the month.`,
    ],
    maxStaleDays: 75,
    frequency: 'monthly',
  };
}

/** The curve history for a country, covering every date in `dates` (YYYY-MM-DD). */
export async function countryCurve(ctx: Ctx, country: string, dates: string[]): Promise<CurveData> {
  const iso2 = countryBy(country)?.iso2 ?? country.trim().toUpperCase();
  switch (iso2) {
    case 'US':
      return usCurve(ctx, dates);
    case 'EA':
      return eaCurve(ctx, dates);
    case 'GB':
      return gbCurve(ctx, dates);
    case 'JP':
      return jpCurve(ctx);
    case 'CA':
      return caCurve(ctx, dates);
    case 'SE':
      return seCurve(ctx, dates);
    case 'BR':
      return brCurve(ctx, dates);
    default:
      return oecdCurve(ctx, iso2, dates);
  }
}
