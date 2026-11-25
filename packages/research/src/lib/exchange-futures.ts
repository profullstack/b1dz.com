/**
 * Futures from Coinbase Derivatives Exchange, through Coinbase's public market
 * data API (no key). The b1dz console already prices crypto from Coinbase;
 * this is the same exchange's regulated futures: crude oil, natural gas, gold,
 * silver, copper, platinum, bitcoin and ether, each with dated contracts.
 *
 * These are Coinbase's own contracts (the crude contract is 10 barrels, not
 * NYMEX's 1,000), quoted in the usual unit: dollars a barrel, an ounce, a
 * pound, a million BTU. Prices track the benchmark futures closely but are not
 * CME settlements, and the change is over 24 hours.
 */
import { SourceError, type Ctx } from '../types.js';

export const CDE = 'Coinbase Derivatives';
const BASE = 'https://api.coinbase.com/api/v3/brokerage/market';

export const CDE_NOTE =
  "Rows from Coinbase Derivatives are that exchange's own contracts (its crude contract is 10 barrels, not NYMEX's 1,000), quoted in the usual unit. They track the benchmark futures closely but are not CME settlements: the change is over 24 hours, and a contract's history starts when it was listed.";
export const CDE_URL = 'https://www.coinbase.com/derivatives';

/** Notes for a futures card: `other` when another venue answered (or none did), the Coinbase note when Coinbase did. */
export function futuresNotes(source: string, other: string): string[] {
  const names = source.split(',').map((s) => s.trim()).filter(Boolean);
  const cde = names.includes(CDE);
  return [...(!cde || names.some((s) => s !== CDE) ? [other] : []), ...(cde ? [CDE_NOTE] : [])];
}
const MONTH_CODES = 'FGHJKMNQUVXZ';

/** Standard futures root -> Coinbase contract root unit. Roots not listed here have no Coinbase contract. */
export const CDE_ROOTS: Record<string, { unit: string; name: string }> = {
  CL: { unit: 'CDEOIL', name: 'Crude oil' },
  NG: { unit: 'CDENGS', name: 'Natural gas' },
  GC: { unit: 'CDEGLD', name: 'Gold' },
  SI: { unit: 'CDESIL', name: 'Silver' },
  HG: { unit: 'CDECU', name: 'Copper' },
  PL: { unit: 'CDEPT', name: 'Platinum' },
  BTC: { unit: 'BTC', name: 'Bitcoin' },
  ETH: { unit: 'ETH', name: 'Ether' },
};

export interface CdeContract {
  /** Coinbase product id, e.g. NOL-18DEC26-CDE. */
  id: string;
  /** Coinbase root unit, e.g. CDEOIL. */
  unit: string;
  name: string;
  /** Expiry, ms since epoch. */
  expiry: number;
  /** Delivery month the exchange names the contract by, YYYY-MM. */
  month: string;
  /** null when the contract has not traded yet. */
  price: number | null;
  /** Percent change over 24 hours. */
  changePct: number | null;
  volume: number | null;
  openInterest: number | null;
  perpetual: boolean;
}

function n(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}

interface RawProduct {
  product_id?: string;
  price?: string;
  price_percentage_change_24h?: string;
  volume_24h?: string;
  is_disabled?: boolean;
  future_product_details?: {
    contract_root_unit?: string;
    contract_expiry?: string;
    contract_expiry_name?: string;
    contract_display_name?: string;
    display_name?: string;
    open_interest?: string;
  };
}

/** `GET /products?product_type=FUTURE` -> contracts. Disabled products and rows without an expiry are dropped. */
export function parseCdeProducts(body: unknown): CdeContract[] {
  const products = (body as { products?: RawProduct[] } | null)?.products;
  if (!Array.isArray(products)) return [];
  const out: CdeContract[] = [];
  for (const p of products) {
    const f = p.future_product_details;
    const expiry = Date.parse(f?.contract_expiry ?? '');
    if (!p.product_id || !f?.contract_root_unit || Number.isNaN(expiry) || p.is_disabled) continue;
    const label = f.contract_display_name ?? f.display_name ?? p.product_id;
    const price = n(p.price);
    out.push({
      id: p.product_id,
      unit: f.contract_root_unit,
      name: f.display_name ?? label,
      expiry,
      month: /^\d{4}-\d{2}$/.test(f.contract_expiry_name ?? '') ? (f.contract_expiry_name as string) : new Date(expiry).toISOString().slice(0, 7),
      price: price !== null && price > 0 ? price : null,
      changePct: n(p.price_percentage_change_24h),
      volume: n(p.volume_24h),
      openInterest: n(f.open_interest),
      // Perpetual-style contracts carry a far-off nominal expiry and say so in their name.
      perpetual: /perp/i.test(label) || /perp/i.test(f.display_name ?? ''),
    });
  }
  return out.sort((a, b) => a.expiry - b.expiry);
}

/**
 * A futures symbol in the usual spelling -> root and, for a dated contract,
 * its delivery month.  `CL=F` -> { root: 'CL' };  `CLF27.NYM` -> { root: 'CL', month: '2027-01' }.
 */
export function futuresRoot(symbol: string): { root: string; month?: string } | null {
  const s = symbol.trim().toUpperCase();
  const front = /^([A-Z0-9]{1,4})=F$/.exec(s);
  if (front) return { root: front[1] };
  const dated = /^([A-Z0-9]{1,4}?)([FGHJKMNQUVXZ])(\d{2})\.[A-Z]{3}$/.exec(s);
  if (!dated) return null;
  const month = MONTH_CODES.indexOf(dated[2]) + 1;
  return { root: dated[1], month: `20${dated[3]}-${String(month).padStart(2, '0')}` };
}

/** True when Coinbase lists a contract for this symbol's root. */
export function cdeCovers(symbol: string): boolean {
  const r = futuresRoot(symbol);
  return !!r && r.root in CDE_ROOTS;
}

async function contracts(ctx: Ctx): Promise<CdeContract[]> {
  const body = await ctx.http.json<unknown>(`${BASE}/products?product_type=FUTURE&limit=500`, { source: CDE, ttl: 60 });
  const all = parseCdeProducts(body);
  if (!all.length) throw new SourceError(CDE, 'no futures products listed');
  return all;
}

/** Dated (non-perpetual, unexpired) contracts for a standard root, nearest first. Unpriced contracts are included. */
export async function cdeChain(ctx: Ctx, root: string): Promise<CdeContract[]> {
  const unit = CDE_ROOTS[root.toUpperCase()]?.unit;
  if (!unit) throw new SourceError(CDE, `no ${root} contract on Coinbase Derivatives`);
  const now = ctx.now().getTime();
  return (await contracts(ctx)).filter((c) => c.unit === unit && !c.perpetual && c.expiry > now);
}

/** The contract a symbol means: the named delivery month, or the nearest contract that has traded. */
export async function cdeContract(ctx: Ctx, symbol: string): Promise<CdeContract> {
  const r = futuresRoot(symbol);
  if (!r || !(r.root in CDE_ROOTS)) throw new SourceError(CDE, `no contract for ${symbol}`);
  const chain = await cdeChain(ctx, r.root);
  const hit = r.month ? chain.find((c) => c.month === r.month) : chain.find((c) => c.price !== null);
  if (!hit) throw new SourceError(CDE, r.month ? `no ${r.root} contract for ${r.month}` : `no ${r.root} contract has traded`);
  if (hit.price === null) throw new SourceError(CDE, `${hit.id} has not traded yet`);
  return hit;
}

export interface CdeBar {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number | null;
}

/** `GET /products/{id}/candles` -> daily bars, oldest first. */
export function parseCdeCandles(body: unknown): CdeBar[] {
  const rows = (body as { candles?: Record<string, string>[] } | null)?.candles;
  if (!Array.isArray(rows)) return [];
  const out: CdeBar[] = [];
  for (const r of rows) {
    const t = Number(r.start) * 1000;
    const [o, h, l, c] = [r.open, r.high, r.low, r.close].map(Number);
    if ([t, o, h, l, c].every(Number.isFinite)) out.push({ t, o, h, l, c, v: n(r.volume) });
  }
  return out.sort((a, b) => a.t - b.t);
}

/**
 * Daily bars for one contract. A contract's history starts when it was
 * listed, so the front month gives a few weeks to a few months, not years.
 */
export async function cdeBars(ctx: Ctx, symbol: string, from: Date, to: Date): Promise<{ bars: CdeBar[]; contract: CdeContract }> {
  const contract = await cdeContract(ctx, symbol);
  const end = Math.floor(to.getTime() / 1000);
  // The API serves at most 350 candles per request.
  const start = Math.max(Math.floor(from.getTime() / 1000), end - 340 * 86_400);
  const body = await ctx.http.json<unknown>(`${BASE}/products/${encodeURIComponent(contract.id)}/candles?start=${start}&end=${end}&granularity=ONE_DAY`, { source: CDE, ttl: 900 });
  return { bars: parseCdeCandles(body), contract };
}
