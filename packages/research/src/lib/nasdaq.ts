/**
 * Nasdaq public market-data API (api.nasdaq.com). No key. Every response is
 * an envelope `{ data, status: { rCode, bCodeMessage } }`; a missing symbol
 * comes back as HTTP 200 with `data: null`, so the envelope is checked here.
 */
import { num } from '../http.js';
import { SourceError, type Ctx } from '../types.js';

export const NASDAQ = 'Nasdaq';

export type NasdaqClass = 'stocks' | 'etf' | 'index';

interface Envelope<T> {
  data: T | null;
  status?: { rCode?: number; bCodeMessage?: { code?: number; errorMessage?: string }[] | null };
}

/** GET an api.nasdaq.com path (starting with "/api/") and unwrap the envelope. */
export async function nasdaqGet<T>(ctx: Ctx, path: string, ttl = 300): Promise<T> {
  const body = await ctx.http.json<Envelope<T>>(`https://api.nasdaq.com${path}`, { source: NASDAQ, ttl });
  if (body.data === null || body.data === undefined) {
    const why = body.status?.bCodeMessage?.map((m) => m.errorMessage).filter(Boolean).join('; ') || 'no data';
    throw new SourceError(NASDAQ, why);
  }
  return body.data;
}

/** Class-share tickers use a dot at Nasdaq (BRK-B -> BRK.B). */
export function nasdaqSymbol(symbol: string): string {
  return symbol.trim().toUpperCase().replace(/-/g, '.');
}

export interface NasdaqInfo {
  symbol: string;
  companyName?: string;
  stockType?: string | null;
  exchange?: string | null;
  isNasdaq100?: boolean;
  marketStatus?: string | null;
  assetClass?: string;
  primaryData?: NasdaqTrade | null;
  secondaryData?: NasdaqTrade | null;
  keyStats?: Record<string, { label?: string; value?: string } | undefined> | null;
}

export interface NasdaqTrade {
  lastSalePrice?: string;
  netChange?: string;
  percentageChange?: string;
  lastTradeTimestamp?: string;
  isRealTime?: boolean;
  volume?: string;
}

/** Widely used ETFs, so a board of them does not spend a request per symbol finding out they are not stocks. */
const KNOWN_ETFS = 'SPY QQQ IWM DIA VTI VOO IVV EFA EEM ACWI VEA VWO TLT IEF SHY LQD HYG AGG BND TIP GLD SLV USO UNG UUP DBC XLK XLC XLY XLP XLF XLV XLI XLE XLB XLRE XLU VTV VUG MTUM QUAL USMV RSP VYM SPHB IWD IWB IWF IWS IWR IWP IWN IWO EWC EWW EWZ EZU EWU EWG EWQ EWI EWP EWL EWD EWJ MCHI EWH EWT EWY INDA EWA EZA';
const classMemo = new Map<string, NasdaqClass>(KNOWN_ETFS.split(' ').map((s) => [s, 'etf']));

/** Quote header for a U.S. stock or ETF; the asset class is discovered once and remembered. */
export async function nasdaqInfo(ctx: Ctx, symbol: string, cls?: NasdaqClass): Promise<{ info: NasdaqInfo; cls: NasdaqClass }> {
  const sym = nasdaqSymbol(symbol);
  const known = cls ?? classMemo.get(sym);
  const order: NasdaqClass[] = known ? [known] : ['stocks', 'etf'];
  let last: unknown;
  for (const c of order) {
    try {
      const info = await nasdaqGet<NasdaqInfo>(ctx, `/api/quote/${encodeURIComponent(sym)}/info?assetclass=${c}`, 60);
      classMemo.set(sym, c);
      return { info, cls: c };
    } catch (e) {
      last = e;
    }
  }
  if (last instanceof SourceError && /not exists/i.test(last.message)) throw new SourceError(NASDAQ, `unknown symbol ${sym} (U.S.-listed stocks and ETFs only)`);
  throw last instanceof Error ? last : new SourceError(NASDAQ, `unknown symbol ${sym}`);
}

/** History for a U.S. listing whose class may not be known yet: the history call itself settles it (no extra quote request). */
export async function nasdaqHistoryAuto(ctx: Ctx, symbol: string, from: Date, to: Date): Promise<NasdaqBar[]> {
  const sym = nasdaqSymbol(symbol);
  const known = classMemo.get(sym);
  if (known) return nasdaqHistory(ctx, sym, known, from, to);
  try {
    const bars = await nasdaqHistory(ctx, sym, 'stocks', from, to);
    classMemo.set(sym, 'stocks');
    return bars;
  } catch (e) {
    if (!(e instanceof SourceError) || e.status !== undefined) throw e;
    const bars = await nasdaqHistory(ctx, sym, 'etf', from, to);
    classMemo.set(sym, 'etf');
    return bars;
  }
}

/** Asset class of a U.S. listing ('stocks' or 'etf'). */
export async function nasdaqClassOf(ctx: Ctx, symbol: string): Promise<NasdaqClass> {
  const sym = nasdaqSymbol(symbol);
  return classMemo.get(sym) ?? (await nasdaqInfo(ctx, sym)).cls;
}

export interface ParsedTrade {
  price: number | null;
  change: number | null;
  changePct: number | null;
  prevClose: number | null;
  time?: string;
}

/** "Nov 24, 2026 8:41 AM ET" / "Closed at Nov 23, 2026 4:00 PM ET" / "Nov 23, 2026" -> ISO (ET treated as the stated wall time). */
export function parseNasdaqTime(s: string | undefined): string | undefined {
  if (!s) return undefined;
  const m = /([A-Z][a-z]{2}) (\d{1,2}), (\d{4})(?:\s+(\d{1,2}):(\d{2})\s*(AM|PM))?/.exec(s);
  if (!m) return undefined;
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'].indexOf(m[1]);
  if (month < 0) return undefined;
  const date = `${m[3]}-${String(month + 1).padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  if (!m[4]) return date;
  let h = Number(m[4]) % 12;
  if (m[6] === 'PM') h += 12;
  return `${date}T${String(h).padStart(2, '0')}:${m[5]}:00 ET`;
}

export function parseTrade(t: NasdaqTrade | null | undefined): ParsedTrade {
  const price = num(t?.lastSalePrice);
  const change = num(t?.netChange);
  const changePct = num(t?.percentageChange);
  return {
    price,
    change,
    changePct,
    prevClose: price !== null && change !== null ? price - change : null,
    time: parseNasdaqTime(t?.lastTradeTimestamp),
  };
}

export interface NasdaqBar {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number | null;
}

/** MM/DD/YYYY -> ms epoch (UTC midnight), or NaN. */
export function usDateMs(s: string): number {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s.trim());
  return m ? Date.UTC(Number(m[3]), Number(m[1]) - 1, Number(m[2])) : NaN;
}

interface HistoricalRow {
  date: string;
  close: string;
  volume?: string;
  open?: string;
  high?: string;
  low?: string;
}

/** Rows of `/historical` (newest first) to bars, oldest first. */
export function parseHistoricalRows(rows: HistoricalRow[]): NasdaqBar[] {
  const out: NasdaqBar[] = [];
  for (const r of rows) {
    const t = usDateMs(r.date);
    const c = num(r.close);
    if (Number.isNaN(t) || c === null) continue;
    out.push({ t, o: num(r.open) ?? c, h: num(r.high) ?? c, l: num(r.low) ?? c, c, v: num(r.volume) });
  }
  return out.sort((a, b) => a.t - b.t);
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Daily bars (split-adjusted, not dividend-adjusted). Nasdaq keeps about ten years. */
export async function nasdaqHistory(ctx: Ctx, symbol: string, cls: NasdaqClass, from: Date, to: Date, ttl = 1800): Promise<NasdaqBar[]> {
  const sym = nasdaqSymbol(symbol);
  const data = await nasdaqGet<{ tradesTable?: { rows?: HistoricalRow[] | null } | null }>(
    ctx,
    `/api/quote/${encodeURIComponent(sym)}/historical?assetclass=${cls}&fromdate=${ymd(from)}&todate=${ymd(to)}&limit=9999`,
    ttl,
  );
  const bars = parseHistoricalRows(data.tradesTable?.rows ?? []);
  if (!bars.length) throw new SourceError(NASDAQ, `no history for ${sym}`);
  return bars;
}
