/** Shared helpers for the rates area: dates, tenor series, SDMX CSV, small statistics. */
import { csvObjects } from '../../http.js';
import type { Ctx } from '../../types.js';

export const DAY = 86_400_000;

export const HORIZONS = ['1M', '3M', '6M', '1Y', '2Y', '5Y'] as const;
export type Horizon = (typeof HORIZONS)[number];

export const RANGE_CHOICES = ['1M', '3M', '6M', '1Y', '2Y', '5Y', '10Y'];

export function ymd(d: Date | number): string {
  return new Date(d).toISOString().slice(0, 10);
}

/** ms epoch (UTC midnight) for YYYY-MM-DD or YYYY-MM. NaN when unparseable. */
export function dayMs(date: string): number {
  return Date.parse(`${date.length === 7 ? `${date}-01` : date.slice(0, 10)}T00:00:00Z`);
}

/** Calendar shift back by a horizon or range label (1M, 6M, 2Y, 10Y). Clamps the day (31 Mar - 1M = 28/29 Feb). */
export function shiftBack(date: string, span: string): string {
  const m = /^(\d+)([MY])$/i.exec(span.trim());
  if (!m) return date;
  const months = Number(m[1]) * (m[2].toUpperCase() === 'Y' ? 12 : 1);
  const [y, mo, d] = date.split('-').map(Number);
  const total = y * 12 + (mo - 1) - months;
  const ny = Math.floor(total / 12);
  const nm = total % 12;
  const lastDay = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
  return `${ny}-${String(nm + 1).padStart(2, '0')}-${String(Math.min(d, lastDay)).padStart(2, '0')}`;
}

/** First day of a `range` param counting back from now. MAX and unknown labels give `maxStart`. */
export function rangeStart(range: string | undefined, now: Date, maxStart = '1990-01-01'): string {
  const r = (range ?? '1Y').toUpperCase();
  return /^\d+[MY]$/.test(r) ? shiftBack(ymd(now), r) : maxStart;
}

/** "1 Mo", "1.5 Month", "10 Yr", "30 YR", "6M", "SR_10Y", "3 month" -> years. null when not a tenor. */
export function tenorYears(label: string): number | null {
  const m = /(\d+(?:\.\d+)?)\s*[-_ ]?\s*(w|wk|week|weeks|m|mo|month|months|y|yr|year|years)\b/i.exec(label.replace(/^SR_/, ''));
  if (!m) return null;
  const n = Number(m[1]);
  const u = m[2].toLowerCase();
  if (u.startsWith('w')) return n / 52;
  if (u.startsWith('m')) return n / 12;
  return n;
}

/** 0.25 -> "3M", 0.125 -> "1.5M", 10 -> "10Y". */
export function tenorLabel(years: number): string {
  if (years < 1) {
    const months = Math.round(years * 12 * 10) / 10;
    return `${months}M`;
  }
  return `${Math.round(years * 100) / 100}Y`;
}

/** One maturity point through time. `points` are [YYYY-MM-DD, percent], oldest first. */
export interface TenorSeries {
  label: string;
  years: number;
  points: [string, number][];
}

/** The last observation on or before `date`, no older than `maxStaleDays`. */
export function valueAsOf(points: [string, number][], date: string, maxStaleDays = 10): { date: string; value: number } | null {
  let lo = 0;
  let hi = points.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid][0] <= date) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  if (found < 0) return null;
  const [d, v] = points[found];
  if (dayMs(date) - dayMs(d) > maxStaleDays * DAY) return null;
  return { date: d, value: v };
}

export function latestDate(series: TenorSeries[]): string {
  let best = '';
  for (const s of series) {
    const last = s.points[s.points.length - 1]?.[0];
    if (last && last > best) best = last;
  }
  return best;
}

/** The curve on a date: one value per tenor (null where the tenor has nothing recent), and the newest date used. */
export function curveAt(series: TenorSeries[], date: string, maxStaleDays = 10): { values: (number | null)[]; date: string } {
  let used = '';
  const values = series.map((s) => {
    const hit = valueAsOf(s.points, date, maxStaleDays);
    if (hit && hit.date > used) used = hit.date;
    return hit ? hit.value : null;
  });
  return { values, date: used };
}

/** Difference in basis points between two percent values, rounded to 0.1 bp. */
export function bpDiff(to: number | null | undefined, from: number | null | undefined): number | null {
  if (to == null || from == null) return null;
  return Math.round((to - from) * 1000) / 10;
}

export function timePoints(points: [string, number][], since?: string): [number, number][] {
  const out: [number, number][] = [];
  for (const [d, v] of points) if (!since || d >= since) out.push([dayMs(d), v]);
  return out;
}

/** Sort ascending by date and drop duplicate dates (the later row wins). */
export function sortPoints(points: [string, number][]): [string, number][] {
  const map = new Map<string, number>();
  for (const [d, v] of points) map.set(d, v);
  return [...map.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

/** Linear interpolation on sorted [x, y] knots. null outside the knots (no extrapolation). */
export function interpolate(knots: [number, number][], x: number): number | null {
  if (!knots.length || x < knots[0][0] || x > knots[knots.length - 1][0]) return null;
  for (let i = 1; i < knots.length; i++) {
    const [x0, y0] = knots[i - 1];
    const [x1, y1] = knots[i];
    if (x <= x1) return x1 === x0 ? y1 : y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
  }
  return knots[knots.length - 1][1];
}

/** Share of `values` at or below `v`, 0 to 100. */
export function percentileRank(values: number[], v: number): number | null {
  if (!values.length) return null;
  let below = 0;
  for (const x of values) if (x <= v) below++;
  return (below / values.length) * 100;
}

export function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** SDMX CSV rows grouped by one dimension into [period, value] series (oldest first). */
export function sdmxSeries(text: string, dim: string | ((row: Record<string, string>) => string)): Map<string, [string, number][]> {
  const out = new Map<string, [string, number][]>();
  for (const r of csvObjects(text)) {
    const v = Number(r.OBS_VALUE);
    if (!r.TIME_PERIOD || r.OBS_VALUE === '' || r.OBS_VALUE === undefined || !Number.isFinite(v)) continue;
    const k = typeof dim === 'string' ? r[dim] : dim(r);
    let list = out.get(k);
    if (!list) out.set(k, (list = []));
    list.push([r.TIME_PERIOD, v]);
  }
  for (const [k, list] of out) out.set(k, sortPoints(list));
  return out;
}

/** ECB Data Portal series as SDMX CSV. `key` may use + to ask for several codes per dimension. */
export async function ecbCsv(ctx: Ctx, flow: string, key: string, query: string, ttl = 3600): Promise<string> {
  return ctx.http.text(`https://data-api.ecb.europa.eu/service/data/${flow}/${key}?${query}&format=csvdata&detail=dataonly`, {
    source: 'ECB',
    ttl,
    headers: { accept: 'text/csv' },
    timeoutMs: 30_000,
  });
}

/** ECB weekly periods ("2026-W46") to the ISO date of that week's Friday; other periods pass through. */
export function ecbPeriodDate(period: string): string {
  const m = /^(\d{4})-W(\d{2})$/.exec(period);
  if (!m) return period.length === 7 ? `${period}-01` : period;
  const jan4 = Date.UTC(Number(m[1]), 0, 4);
  const dow = new Date(jan4).getUTCDay() || 7;
  const week1Monday = jan4 - (dow - 1) * DAY;
  return ymd(week1Monday + (Number(m[2]) - 1) * 7 * DAY + 4 * DAY);
}

export interface Country {
  iso2: string;
  iso3: string;
  name: string;
}

/** Countries the OECD monthly rates and the BIS policy-rate set cover. EA is the euro area (OECD EA20, BIS XM). */
export const COUNTRIES: Country[] = (
  'US:USA:United States,EA:EA20:Euro area,DE:DEU:Germany,GB:GBR:United Kingdom,JP:JPN:Japan,CA:CAN:Canada,SE:SWE:Sweden,BR:BRA:Brazil,' +
  'AU:AUS:Australia,AT:AUT:Austria,BE:BEL:Belgium,BG:BGR:Bulgaria,CH:CHE:Switzerland,CL:CHL:Chile,CN:CHN:China,CO:COL:Colombia,' +
  'CR:CRI:Costa Rica,CZ:CZE:Czechia,DK:DNK:Denmark,ES:ESP:Spain,EE:EST:Estonia,FI:FIN:Finland,FR:FRA:France,GR:GRC:Greece,' +
  'HR:HRV:Croatia,HU:HUN:Hungary,ID:IDN:Indonesia,IN:IND:India,IE:IRL:Ireland,IS:ISL:Iceland,IL:ISR:Israel,IT:ITA:Italy,' +
  'KR:KOR:South Korea,LT:LTU:Lithuania,LU:LUX:Luxembourg,LV:LVA:Latvia,MX:MEX:Mexico,NL:NLD:Netherlands,NO:NOR:Norway,' +
  'NZ:NZL:New Zealand,PL:POL:Poland,PT:PRT:Portugal,RO:ROU:Romania,RU:RUS:Russia,SK:SVK:Slovakia,SI:SVN:Slovenia,ZA:ZAF:South Africa,' +
  'AR:ARG:Argentina,HK:HKG:Hong Kong,KW:KWT:Kuwait,MA:MAR:Morocco,MK:MKD:North Macedonia,MY:MYS:Malaysia,PE:PER:Peru,' +
  'PH:PHL:Philippines,RS:SRB:Serbia,SA:SAU:Saudi Arabia,TH:THA:Thailand,TR:TUR:Türkiye'
)
  .split(',')
  .map((s) => {
    const [iso2, iso3, name] = s.split(':');
    return { iso2, iso3, name };
  });

export function countryBy(code: string): Country | undefined {
  const c = code.trim().toUpperCase();
  if (c === 'XM' || c === 'EA20' || c === 'EZ') return COUNTRIES[1];
  if (c === 'UK') return COUNTRIES.find((x) => x.iso2 === 'GB');
  return COUNTRIES.find((x) => x.iso2 === c || x.iso3 === c);
}

/** Members of the euro area share the ECB's policy rate (BIS files it under XM). */
export const EURO_MEMBERS = new Set(['AT', 'BE', 'BG', 'HR', 'EE', 'FI', 'FR', 'DE', 'GR', 'IE', 'IT', 'LV', 'LT', 'LU', 'NL', 'PT', 'SK', 'SI', 'ES']);

export function bisArea(iso2: string): string {
  return iso2 === 'EA' || EURO_MEMBERS.has(iso2) ? 'XM' : iso2;
}
