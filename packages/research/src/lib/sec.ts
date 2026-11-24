/**
 * SEC EDGAR: ticker -> CIK, a company's filing list, XBRL company facts and
 * filing documents. `ctx.http` identifies itself to sec.gov hosts and spaces
 * requests, which keeps us far below the SEC's 10 requests/second limit.
 */
import { SourceError, type Ctx } from '../types.js';

export const SEC = 'SEC EDGAR';

export interface SecTicker {
  cik: number;
  ticker: string;
  title: string;
}

/** One memo slot per key so multi-megabyte bodies are parsed once, not on every card. */
const parsed = new Map<string, { at: number; value: unknown }>();
function memo<T>(key: string, ttlSec: number, make: () => Promise<T>): Promise<T> {
  const hit = parsed.get(key);
  if (hit && Date.now() - hit.at < ttlSec * 1000) return Promise.resolve(hit.value as T);
  return make().then((value) => {
    if (parsed.size > 24) parsed.delete(parsed.keys().next().value as string);
    parsed.set(key, { at: Date.now(), value });
    return value;
  });
}

/** `company_tickers.json` is an object keyed "0", "1", ... ordered by market value. */
export function parseTickers(body: unknown): SecTicker[] {
  const out: SecTicker[] = [];
  for (const v of Object.values((body ?? {}) as Record<string, { cik_str?: number; ticker?: string; title?: string }>)) {
    if (v && typeof v.cik_str === 'number' && v.ticker) out.push({ cik: v.cik_str, ticker: v.ticker.toUpperCase(), title: v.title ?? '' });
  }
  return out;
}

export function secTickers(ctx: Ctx): Promise<SecTicker[]> {
  return memo('tickers', 86_400, async () => parseTickers(await ctx.http.json('https://www.sec.gov/files/company_tickers.json', { source: SEC, ttl: 86_400 })));
}

export interface FundTicker {
  cik: number;
  seriesId: string;
  classId: string;
  symbol: string;
}

/** Mutual fund and ETF share classes: ticker -> registrant CIK and series id. */
export function fundTickers(ctx: Ctx): Promise<FundTicker[]> {
  return memo('fundTickers', 86_400, async () => {
    const body = await ctx.http.json<{ data?: [number, string, string, string][] }>('https://www.sec.gov/files/company_tickers_mf.json', { source: SEC, ttl: 86_400 });
    return (body.data ?? []).map(([cik, seriesId, classId, symbol]) => ({ cik, seriesId, classId, symbol: String(symbol).toUpperCase() }));
  });
}

/** SEC tickers use a hyphen for share classes (BRK-B). */
export function secSymbol(symbol: string): string {
  return symbol.trim().toUpperCase().replace(/[./]/g, '-');
}

export async function cikFor(ctx: Ctx, symbol: string): Promise<SecTicker> {
  const raw = symbol.trim();
  const list = await secTickers(ctx);
  const asCik = /^(?:CIK\s*)?0*(\d{1,10})$/i.exec(raw);
  if (asCik) {
    const cik = Number(asCik[1]);
    return list.find((t) => t.cik === cik) ?? { cik, ticker: '', title: `CIK ${cik}` };
  }
  const want = secSymbol(raw);
  const hit = list.find((t) => t.ticker === want);
  if (!hit) throw new SourceError(SEC, `no SEC registrant for ticker ${want} (funds and non-U.S. listings are not in the company list)`);
  return hit;
}

export function cik10(cik: number): string {
  return String(cik).padStart(10, '0');
}

export interface Filing {
  accession: string;
  form: string;
  filingDate: string;
  reportDate: string;
  primaryDocument: string;
  description: string;
  items: string;
}

interface SubmissionsBody {
  name?: string;
  sic?: string;
  sicDescription?: string;
  category?: string;
  fiscalYearEnd?: string;
  stateOfIncorporation?: string;
  tickers?: string[];
  exchanges?: string[];
  filings?: { recent?: Record<string, (string | number)[]> };
}

export interface Submissions {
  name: string;
  sic?: string;
  sicDescription?: string;
  fiscalYearEnd?: string;
  filings: Filing[];
}

/** The columnar `filings.recent` block to one object per filing (newest first, as EDGAR sends it). */
export function parseSubmissions(body: SubmissionsBody): Submissions {
  const r = body.filings?.recent ?? {};
  const n = (r.accessionNumber ?? []).length;
  const col = (k: string, i: number): string => String(r[k]?.[i] ?? '');
  const filings: Filing[] = [];
  for (let i = 0; i < n; i++) {
    filings.push({
      accession: col('accessionNumber', i),
      form: col('form', i),
      filingDate: col('filingDate', i),
      reportDate: col('reportDate', i),
      primaryDocument: col('primaryDocument', i),
      description: col('primaryDocDescription', i),
      items: col('items', i),
    });
  }
  return { name: body.name ?? '', sic: body.sic, sicDescription: body.sicDescription, fiscalYearEnd: body.fiscalYearEnd, filings };
}

export async function submissions(ctx: Ctx, cik: number): Promise<Submissions> {
  return parseSubmissions(await ctx.http.json<SubmissionsBody>(`https://data.sec.gov/submissions/CIK${cik10(cik)}.json`, { source: SEC, ttl: 900 }));
}

function folder(cik: number, accession: string): string {
  return `https://www.sec.gov/Archives/edgar/data/${cik}/${accession.replace(/-/g, '')}`;
}

/** URL of a document inside a filing. XSL-rendered names ("xslF345X06/form4.xml") point at the raw file. */
export function filingDocUrl(cik: number, accession: string, doc: string): string {
  return `${folder(cik, accession)}/${doc.replace(/^xsl[^/]*\//, '')}`;
}

/** The filing's index page (every document and exhibit, for a person). */
export function filingIndexUrl(cik: number, accession: string): string {
  return `${folder(cik, accession)}/${accession}-index.htm`;
}

export interface FilingDoc {
  seq: string;
  description: string;
  name: string;
  type: string;
  url: string;
}

/** Document table of a filing index page: sequence, description, file, type. */
export function parseFilingIndex(html: string): FilingDoc[] {
  const out: FilingDoc[] = [];
  for (const row of html.match(/<tr[\s\S]*?<\/tr>/gi) ?? []) {
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => m[1]);
    if (cells.length < 4) continue;
    const href = /href="([^"]+)"/i.exec(cells[2])?.[1];
    if (!href || !href.includes('/Archives/')) continue;
    const path = href.replace(/^\/ix\?doc=/, '');
    out.push({
      seq: htmlToText(cells[0]),
      description: htmlToText(cells[1]),
      name: path.split('/').pop() ?? '',
      type: htmlToText(cells[3]),
      url: `https://www.sec.gov${path}`,
    });
  }
  return out;
}

export async function filingDocs(ctx: Ctx, cik: number, accession: string): Promise<FilingDoc[]> {
  return parseFilingIndex(await ctx.http.text(filingIndexUrl(cik, accession), { source: SEC, ttl: 21_600 }));
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '-', mdash: '-', rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"', bull: '*', middot: '*', reg: '(R)', copy: '(C)', trade: '(TM)', hellip: '...', sect: 'S.' };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (all, e: string) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      if (!Number.isFinite(code)) return all;
      if (code === 160) return ' ';
      if (code === 8211 || code === 8212) return '-';
      if (code === 8216 || code === 8217) return "'";
      if (code === 8220 || code === 8221) return '"';
      return String.fromCodePoint(code);
    }
    return ENTITIES[e.toLowerCase()] ?? all;
  });
}

/** Readable text from filing HTML: block tags become line breaks, everything else is dropped. */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style|head|ix:header)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<\/(p|div|tr|li|h[1-6]|table)>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/t[dh]>/gi, ' ')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export interface XbrlFact {
  start?: string;
  end: string;
  val: number;
  fy?: number;
  fp?: string;
  form?: string;
  filed?: string;
  frame?: string;
  accn?: string;
}

export interface CompanyFacts {
  cik?: number;
  entityName?: string;
  facts?: Record<string, Record<string, { label?: string; units?: Record<string, XbrlFact[]> }>>;
}

/** Every XBRL fact a company has reported. Large (several MB for a mega cap); cached for six hours. */
export function companyFacts(ctx: Ctx, cik: number): Promise<CompanyFacts> {
  return memo(`facts:${cik}`, 21_600, () => ctx.http.json<CompanyFacts>(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik10(cik)}.json`, { source: SEC, ttl: 21_600, timeoutMs: 40_000 }));
}

/** Items of an RSS 2.0 or Atom feed: title, link, date and a plain-text summary. */
export function parseFeed(xml: string): { title: string; link: string; date: string; summary: string }[] {
  const out: { title: string; link: string; date: string; summary: string }[] = [];
  const tag = (block: string, name: string): string => {
    const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i').exec(block);
    return m ? htmlToText(decodeEntities(m[1].replace(/^<!\[CDATA\[|\]\]>$/g, ''))) : '';
  };
  for (const block of xml.match(/<(item|entry)[\s>][\s\S]*?<\/\1>/gi) ?? []) {
    const href = /<link[^>]*href="([^"]+)"/i.exec(block)?.[1];
    const rawDate = tag(block, 'pubDate') || tag(block, 'updated') || tag(block, 'dc:date');
    const t = Date.parse(rawDate);
    out.push({
      title: tag(block, 'title').replace(/\s+/g, ' '),
      link: href ?? tag(block, 'link'),
      date: Number.isNaN(t) ? rawDate : new Date(t).toISOString(),
      summary: (tag(block, 'description') || tag(block, 'summary')).replace(/\s+/g, ' '),
    });
  }
  return out;
}
