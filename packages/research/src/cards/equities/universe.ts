/** The Nasdaq stock screener's full listing (every U.S.-listed stock with sector and industry), parsed once. */
import { num } from '../../http.js';
import { NASDAQ, nasdaqGet } from '../../lib/nasdaq.js';
import { SourceError, type Ctx } from '../../types.js';

export interface Listing {
  symbol: string;
  name: string;
  last: number | null;
  changePct: number | null;
  marketCap: number | null;
  volume: number | null;
  country: string;
  sector: string;
  industry: string;
}

interface RawRow {
  symbol?: string;
  name?: string;
  lastsale?: string;
  pctchange?: string;
  marketCap?: string;
  volume?: string;
  country?: string;
  sector?: string;
  industry?: string;
}

export function parseListings(rows: RawRow[] | null | undefined): Listing[] {
  return (rows ?? [])
    .filter((r) => r.symbol)
    .map((r) => ({
      symbol: r.symbol!.trim().toUpperCase().replace(/\//g, '.'),
      name: (r.name ?? '').trim(),
      last: num(r.lastsale),
      changePct: num(r.pctchange),
      marketCap: num(r.marketCap) || null,
      volume: num(r.volume),
      country: r.country ?? '',
      sector: r.sector ?? '',
      industry: r.industry ?? '',
    }));
}

let cached: { at: number; list: Listing[] } | undefined;

export async function universe(ctx: Ctx): Promise<Listing[]> {
  if (cached && Date.now() - cached.at < 6 * 3_600_000) return cached.list;
  const data = await nasdaqGet<{ rows?: RawRow[] | null }>(ctx, '/api/screener/stocks?tableonly=true&download=true', 21_600);
  const list = parseListings(data.rows);
  if (!list.length) throw new SourceError(NASDAQ, 'the stock screener returned no rows');
  cached = { at: Date.now(), list };
  return list;
}

/** Company name without share-class and legal-form words, for matching the same issuer across sources. */
export function issuerKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\b(common|ordinary|capital|depositary|american)\b.*$/, '')
    .replace(/\bclass [a-z]\b.*$/, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\b(the|inc|incorporated|corp|corporation|co|company|ltd|limited|plc|sa|nv|ag|se|holdings?|group|trust|lp|llc|new|de)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Listings that are not a company's common equity. */
const NOT_COMMON = /preferred|warrant|\bnotes?\b|debenture|\bunits?$|\brights?$|% /i;

/**
 * Comparable companies: same industry (same sector when the industry is too
 * thin), nearest in market value, one share class per issuer.
 */
export function pickPeers(list: Listing[], symbol: string, count = 6): string[] {
  const want = symbol.toUpperCase().replace(/-/g, '.');
  const self = list.find((l) => l.symbol === want);
  if (!self || !self.marketCap) return [];
  const selfKey = issuerKey(self.name);
  const dist = (l: Listing): number => Math.abs(Math.log(l.marketCap! / self.marketCap!));
  const pool = (same: (l: Listing) => boolean): Listing[] => {
    const seen = new Set<string>([selfKey]);
    const out: Listing[] = [];
    for (const l of list.filter((x) => x.symbol !== want && x.marketCap && !NOT_COMMON.test(x.name) && same(x)).sort((a, b) => dist(a) - dist(b))) {
      const k = issuerKey(l.name);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(l);
    }
    return out;
  };
  let peers = self.industry ? pool((l) => l.industry === self.industry) : [];
  if (peers.length < 3 && self.sector) peers = pool((l) => l.sector === self.sector);
  return peers.slice(0, count).map((l) => l.symbol);
}
