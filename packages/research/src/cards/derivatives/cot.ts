/**
 * CFTC Commitments of Traders, from the CFTC public reporting portal
 * (Socrata, no key). Shared with other areas: import `getCot` from here.
 *
 *   const cot = await getCot(ctx, { market: '13874A', report: 'financial', weeks: 52 });
 *   const cot = await getCot(ctx, { market: 'WTI-PHYSICAL', report: 'disaggregated' });
 *
 * `market` is a CFTC contract market code (six characters, e.g. `13874A` for
 * the E-mini S&P 500, `067651` for NYMEX WTI) or a contract market name as
 * the CFTC prints it (`UST 10Y NOTE`, `GOLD`, `EURO FX`; case-insensitive).
 * A name that matches several contracts resolves to the one with the largest
 * open interest in the latest report. Codes are unambiguous: prefer them.
 *
 * `report`:
 *   'financial'      Traders in Financial Futures: equity index, rates,
 *                    currency and crypto futures. Categories: dealer,
 *                    assetManager, leveraged, other, nonReportable.
 *   'disaggregated'  Disaggregated report: physical commodities. Categories:
 *                    producer, swapDealer, managedMoney, other, nonReportable.
 *
 * Futures only (no options) by default; pass `combined: true` for futures
 * and options combined. Weeks come back newest first. Positions are in
 * contracts. Reports are as of Tuesday and published the following Friday.
 */
import { num } from '../../http.js';
import { SourceError, type Ctx } from '../../types.js';

export type CotReport = 'financial' | 'disaggregated';

export interface CotOptions {
  /** CFTC contract market code or contract market name. */
  market: string;
  /** Default 'financial'. */
  report?: CotReport;
  /** How many weekly reports to return. Default 52. */
  weeks?: number;
  /** Futures and options combined instead of futures only. Default false. */
  combined?: boolean;
}

export interface CotPosition {
  long: number;
  short: number;
  /** Spreading positions; null for categories the report does not give one for. */
  spread: number | null;
  /** long minus short. */
  net: number;
}

export interface CotWeek {
  /** Report date (a Tuesday), YYYY-MM-DD. */
  date: string;
  openInterest: number | null;
  positions: Record<string, CotPosition>;
}

export interface CotCategory {
  key: string;
  label: string;
}

export interface CotData {
  /** Contract market name as the CFTC prints it. */
  market: string;
  code: string;
  /** "E-MINI S&P 500 - CHICAGO MERCANTILE EXCHANGE". */
  marketAndExchange: string;
  /** Contract size text, e.g. "($50 X S&P 500 INDEX)". */
  units: string;
  report: CotReport;
  combined: boolean;
  categories: CotCategory[];
  /** Newest first. */
  weeks: CotWeek[];
  source: 'CFTC';
  sourceUrl: string;
}

export const COT_SOURCE = 'CFTC';
export const COT_URL = 'https://www.cftc.gov/MarketReports/CommitmentsofTraders/index.htm';
const BASE = 'https://publicreporting.cftc.gov/resource';

/** Socrata dataset ids on publicreporting.cftc.gov. */
const DATASETS: Record<CotReport, { futures: string; combined: string }> = {
  financial: { futures: 'gpe5-46if', combined: 'yw9f-hn96' },
  disaggregated: { futures: '72hh-3qpy', combined: 'kh3c-gbw2' },
};

interface FieldMap extends CotCategory {
  long: string;
  short: string;
  spread?: string;
}

/** Column names are the portal's own, including its double underscores. */
const FIELDS: Record<CotReport, FieldMap[]> = {
  financial: [
    { key: 'dealer', label: 'Dealers', long: 'dealer_positions_long_all', short: 'dealer_positions_short_all', spread: 'dealer_positions_spread_all' },
    { key: 'assetManager', label: 'Asset managers', long: 'asset_mgr_positions_long', short: 'asset_mgr_positions_short', spread: 'asset_mgr_positions_spread' },
    { key: 'leveraged', label: 'Leveraged funds', long: 'lev_money_positions_long', short: 'lev_money_positions_short', spread: 'lev_money_positions_spread' },
    { key: 'other', label: 'Other reportables', long: 'other_rept_positions_long', short: 'other_rept_positions_short', spread: 'other_rept_positions_spread' },
    { key: 'nonReportable', label: 'Non-reportable', long: 'nonrept_positions_long_all', short: 'nonrept_positions_short_all' },
  ],
  disaggregated: [
    { key: 'producer', label: 'Producers / merchants', long: 'prod_merc_positions_long', short: 'prod_merc_positions_short' },
    { key: 'swapDealer', label: 'Swap dealers', long: 'swap_positions_long_all', short: 'swap__positions_short_all', spread: 'swap__positions_spread_all' },
    { key: 'managedMoney', label: 'Managed money', long: 'm_money_positions_long_all', short: 'm_money_positions_short_all', spread: 'm_money_positions_spread' },
    { key: 'other', label: 'Other reportables', long: 'other_rept_positions_long', short: 'other_rept_positions_short', spread: 'other_rept_positions_spread' },
    { key: 'nonReportable', label: 'Non-reportable', long: 'nonrept_positions_long_all', short: 'nonrept_positions_short_all' },
  ],
};

export function cotCategories(report: CotReport): CotCategory[] {
  return FIELDS[report].map(({ key, label }) => ({ key, label }));
}

type RawRow = Record<string, string | undefined>;

/** CFTC contract market codes are six characters and start with a digit (`13874A`, `13874+`). */
export function isCotCode(market: string): boolean {
  return /^\d[0-9A-Za-z+]{5}$/.test(market.trim());
}

/** Rows of one contract from the portal to weeks, newest first. Rows without a date or positions are dropped. */
export function parseCotRows(rows: RawRow[], report: CotReport): CotWeek[] {
  const weeks: CotWeek[] = [];
  for (const r of rows) {
    const date = (r.report_date_as_yyyy_mm_dd ?? '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const positions: Record<string, CotPosition> = {};
    for (const f of FIELDS[report]) {
      const long = num(r[f.long]);
      const short = num(r[f.short]);
      if (long === null || short === null) continue;
      positions[f.key] = { long, short, spread: f.spread ? num(r[f.spread]) : null, net: long - short };
    }
    if (!Object.keys(positions).length) continue;
    weeks.push({ date, openInterest: num(r.open_interest_all), positions });
  }
  return weeks.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

/** Net position of one category, oldest first, as chart points [ms epoch, contracts]. */
export function cotNetSeries(weeks: CotWeek[], key: string): [number, number][] {
  const out: [number, number][] = [];
  for (const w of weeks) {
    const p = w.positions[key];
    if (p) out.push([Date.parse(`${w.date}T00:00:00Z`), p.net]);
  }
  return out.sort((a, b) => a[0] - b[0]);
}

/** Week-over-week change in a category's net position (latest minus the report before it). */
export function cotNetChange(weeks: CotWeek[], key: string): number | null {
  const a = weeks[0]?.positions[key];
  const b = weeks[1]?.positions[key];
  return a && b ? a.net - b.net : null;
}

const quote = (s: string): string => `'${s.replace(/'/g, "''")}'`;

async function query(ctx: Ctx, dataset: string, params: Record<string, string>): Promise<RawRow[]> {
  const qs = Object.entries(params)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&');
  const rows = await ctx.http.json<RawRow[]>(`${BASE}/${dataset}.json?${qs}`, { source: COT_SOURCE, ttl: 3600 });
  if (!Array.isArray(rows)) throw new SourceError(COT_SOURCE, 'unexpected response');
  return rows;
}

/** Resolve a contract name to the code with the largest open interest in the newest report that lists it. */
async function resolveCode(ctx: Ctx, dataset: string, name: string): Promise<string> {
  const upper = name.trim().toUpperCase();
  const find = async (where: string): Promise<string | undefined> => {
    const rows = await query(ctx, dataset, {
      $select: 'cftc_contract_market_code,report_date_as_yyyy_mm_dd,open_interest_all',
      $where: where,
      $order: 'report_date_as_yyyy_mm_dd DESC',
      $limit: '40',
    });
    if (!rows.length) return undefined;
    const newest = rows[0].report_date_as_yyyy_mm_dd;
    const latest = rows.filter((r) => r.report_date_as_yyyy_mm_dd === newest);
    latest.sort((a, b) => (num(b.open_interest_all) ?? 0) - (num(a.open_interest_all) ?? 0));
    return latest[0].cftc_contract_market_code;
  };
  const code =
    (await find(`upper(contract_market_name) = ${quote(upper)}`)) ??
    (await find(`upper(contract_market_name) like ${quote(`%${upper}%`)}`));
  if (!code) throw new SourceError(COT_SOURCE, `no contract named "${name}" in the ${dataset} report`);
  return code;
}

export async function getCot(ctx: Ctx, opts: CotOptions): Promise<CotData> {
  const report: CotReport = opts.report ?? 'financial';
  const combined = opts.combined ?? false;
  const weeksWanted = Math.max(1, Math.min(1000, Math.floor(opts.weeks ?? 52)));
  const dataset = DATASETS[report][combined ? 'combined' : 'futures'];
  const market = opts.market.trim();
  if (!market) throw new SourceError(COT_SOURCE, 'no market given');
  const code = isCotCode(market) ? market.toUpperCase() : await resolveCode(ctx, dataset, market);
  const rows = await query(ctx, dataset, {
    $where: `cftc_contract_market_code = ${quote(code)}`,
    $order: 'report_date_as_yyyy_mm_dd DESC',
    $limit: String(weeksWanted),
  });
  const weeks = parseCotRows(rows, report);
  if (!weeks.length) {
    const other = report === 'financial' ? 'disaggregated' : 'financial';
    throw new SourceError(COT_SOURCE, `no ${report} report rows for contract ${code} (try report: '${other}')`);
  }
  const head = rows.find((r) => (r.report_date_as_yyyy_mm_dd ?? '').slice(0, 10) === weeks[0].date) ?? rows[0];
  return {
    market: head.contract_market_name ?? code,
    code,
    marketAndExchange: head.market_and_exchange_names ?? head.contract_market_name ?? code,
    units: head.contract_units ?? '',
    report,
    combined,
    categories: cotCategories(report),
    weeks,
    source: COT_SOURCE,
    sourceUrl: COT_URL,
  };
}
