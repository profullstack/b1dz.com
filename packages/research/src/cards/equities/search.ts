/** Security search: ticker, company name, SEC CIK or CUSIP -> the Company or ETFs dashboard. */
import { NASDAQ } from '../../lib/nasdaq.js';
import { fundTickers, SEC, secTickers, type SecTicker } from '../../lib/sec.js';
import type { Ctx, SearchHit, SearchProvider } from '../../types.js';

interface Auto {
  symbol?: string;
  name?: string;
  exchange?: string;
  asset?: string;
}

function stockHit(symbol: string, name: string, detail: string): SearchHit {
  return { kind: 'security', label: `${symbol}  ${name}`.trim(), detail, dashboard: 'company', tab: 'overview', params: { symbol } };
}
function fundHit(symbol: string, name: string, detail: string): SearchHit {
  return { kind: 'security', label: `${symbol}  ${name}`.trim(), detail, dashboard: 'etfs', params: { symbol } };
}

/** Rank SEC registrants for a text query: exact ticker, ticker prefix, name starts with, name contains (the list is already largest first). */
export function rankTickers(list: SecTicker[], query: string, limit = 8): SecTicker[] {
  const q = query.trim().toUpperCase();
  if (!q) return [];
  const sym = q.replace(/[./]/g, '-');
  const buckets: SecTicker[][] = [[], [], [], []];
  for (const t of list) {
    const title = t.title.toUpperCase();
    if (t.ticker === sym) buckets[0].push(t);
    else if (q.length <= 5 && t.ticker.startsWith(sym)) buckets[1].push(t);
    else if (q.length >= 3 && title.startsWith(q)) buckets[2].push(t);
    else if (q.length >= 4 && title.includes(q)) buckets[3].push(t);
  }
  const seen = new Set<string>();
  const out: SecTicker[] = [];
  for (const t of buckets.flat()) {
    if (seen.has(t.ticker)) continue;
    seen.add(t.ticker);
    out.push(t);
    if (out.length >= limit) break;
  }
  return out;
}

/** A 9-character CUSIP: letters and digits with at least two digits (so ordinary words do not qualify). */
export function looksLikeCusip(q: string): boolean {
  return /^[0-9A-Z]{9}$/i.test(q) && (q.match(/\d/g) ?? []).length >= 2;
}

/** "Apple Inc.  (AAPL)  (CIK 0000320193)" -> { name, ticker, cik }. */
export function parseDisplayName(s: string): { name: string; ticker: string; cik: number } | null {
  const m = /^(.*?)\s*(?:\(([A-Z0-9.\-, ]+)\)\s*)?\(CIK (\d{10})\)\s*$/.exec(s.replace(/\s+/g, ' ').trim());
  if (!m) return null;
  return { name: m[1].trim(), ticker: (m[2] ?? '').split(',')[0].trim(), cik: Number(m[3]) };
}

/** A CUSIP names its issuer on Schedule 13G cover pages, where the issuer is the first party listed. */
async function byCusip(ctx: Ctx, cusip: string): Promise<SearchHit[]> {
  const body = await ctx.http.json<{ hits?: { hits?: { _source?: { display_names?: string[] } }[] } }>(
    `https://efts.sec.gov/LATEST/search-index?q=%22${encodeURIComponent(cusip.toUpperCase())}%22&forms=${encodeURIComponent('SC 13G,SC 13G/A,SCHEDULE 13G,SCHEDULE 13G/A')}`,
    { source: SEC, ttl: 86_400 },
  );
  const votes = new Map<string, { n: number; name: string; ticker: string; cik: number }>();
  for (const h of body.hits?.hits ?? []) {
    const p = parseDisplayName(h._source?.display_names?.[0] ?? '');
    if (!p) continue;
    const e = votes.get(String(p.cik)) ?? { n: 0, ...p };
    e.n += 1;
    votes.set(String(p.cik), e);
  }
  const best = [...votes.values()].sort((a, b) => b.n - a.n)[0];
  if (!best) return [];
  const detail = `CUSIP ${cusip.toUpperCase()} · CIK ${best.cik} · issuer named on ${best.n} Schedule 13G filings`;
  return best.ticker ? [stockHit(best.ticker, best.name, detail)] : [];
}

export const search: SearchProvider = async (ctx, query) => {
  const q = query.trim();
  if (q.length < 1 || q.length > 60) return [];

  const cik = /^(?:CIK\s*#?\s*)(\d{1,10})$/i.exec(q) ?? /^(\d{6,10})$/.exec(q);
  if (cik) {
    const n = Number(cik[1]);
    const hits = (await secTickers(ctx)).filter((t) => t.cik === n);
    if (hits.length) return hits.map((t) => stockHit(t.ticker, t.title, `CIK ${n} · SEC registrant`));
  }
  if (looksLikeCusip(q)) {
    const hits = await byCusip(ctx, q).catch(() => []);
    if (hits.length) return hits;
  }

  const [auto, sec, funds] = await Promise.all([
    ctx.http
      .json<{ data?: Auto[] | null }>(`https://api.nasdaq.com/api/autocomplete/slookup/10?search=${encodeURIComponent(q)}`, { source: NASDAQ, ttl: 3600, timeoutMs: 8000 })
      .then((b) => b.data ?? [])
      .catch(() => [] as Auto[]),
    secTickers(ctx).catch(() => [] as SecTicker[]),
    fundTickers(ctx).catch(() => []),
  ]);
  const fundSet = new Set(funds.map((f) => f.symbol));
  const out: SearchHit[] = [];
  const seen = new Set<string>();
  const push = (h: SearchHit): void => {
    const s = h.params?.symbol ?? h.label;
    if (seen.has(s)) return;
    seen.add(s);
    out.push(h);
  };
  // An exact ticker match goes first whatever the autocomplete ranking says.
  const exact = rankTickers(sec, q, 1).find((t) => t.ticker === q.toUpperCase().replace(/[./]/g, '-'));
  if (exact) {
    const asset = auto.find((a) => (a.symbol ?? '').toUpperCase().replace(/\./g, '-') === exact.ticker)?.asset;
    if (asset === 'ETF' || fundSet.has(exact.ticker)) push(fundHit(exact.ticker, exact.title, `Fund · CIK ${exact.cik}`));
    else push(stockHit(exact.ticker, exact.title, `Stock · CIK ${exact.cik}`));
  }
  for (const a of auto) {
    if (!a.symbol) continue;
    const symbol = a.symbol.toUpperCase().replace(/\./g, '-');
    const name = (a.name ?? '').replace(/ (Common Stock|Ordinary Shares|Common Shares)$/i, '');
    if (a.asset === 'STOCKS') push(stockHit(symbol, name, ['Stock', a.exchange].filter(Boolean).join(' · ')));
    else if (a.asset === 'ETF') push(fundHit(symbol, name, ['ETF', a.exchange].filter(Boolean).join(' · ')));
  }
  for (const t of rankTickers(sec, q, 8)) {
    push(fundSet.has(t.ticker) ? fundHit(t.ticker, t.title, `Fund · CIK ${t.cik}`) : stockHit(t.ticker, t.title, `Stock · CIK ${t.cik}`));
  }
  return out.slice(0, 12);
};
