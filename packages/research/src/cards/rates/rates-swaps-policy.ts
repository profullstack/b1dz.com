/** Rates & Curves: Swaps & OIS (swap data repository prints) and Policy Expectations (FOMC documents). */
import { num } from '../../http.js';
import { SourceError, type Block, type CardDef, type Ctx, type Row } from '../../types.js';
import { DAY, dayMs, median } from './util.js';

// ---------- Swap data repository (public dissemination under CFTC rules) ----------

/** One publicly disseminated swap report. Every field is a string or null in the feed. */
export interface SdrTrade {
  actionType?: string | null;
  eventType?: string | null;
  assetClass?: string | null;
  executionTimestamp?: string | null;
  eventTimestamp?: string | null;
  effectiveDate?: string | null;
  expirationDate?: string | null;
  notionalAmountLeg1?: string | null;
  notionalCurrencyLeg1?: string | null;
  fixedRateLeg1?: string | null;
  fixedRateLeg2?: string | null;
  spreadLeg1?: string | null;
  spreadNotationLeg1?: string | null;
  cleared?: string | null;
  platformIdentifier?: string | null;
  uniqueProductIdentifierShortName?: string | null;
  uniqueProductIdentifierUnderlierName?: string | null;
  blocktradeElectionIndicator?: string | null;
}

export const SDR_URL = 'https://pddata.dtcc.com/ppd/cftcdashboard';

/** The most recent batch of reports for an asset class (RATES, CREDITS). The feed returns about a hundred. */
export async function sdrTrades(ctx: Ctx, assetClass: 'RATES' | 'CREDITS'): Promise<SdrTrade[]> {
  const body = await ctx.http.json<{ tradeList?: SdrTrade[] }>(`https://pddata.dtcc.com/ppd/api/ticker/CFTC/${assetClass}`, { source: 'DTCC SDR', ttl: 120, timeoutMs: 30_000 });
  if (!body.tradeList?.length) throw new SourceError('DTCC SDR', `no ${assetClass.toLowerCase()} trade reports in the latest batch`);
  return body.tradeList;
}

export interface SwapPrint {
  time: string;
  product: string;
  currency: string;
  effective: string;
  maturity: string;
  tenorYears: number | null;
  /** Percent. */
  rate: number;
  notional: number | null;
  /** The feed caps large sizes and marks them with a trailing plus. */
  capped: boolean;
  cleared: string;
  venue: string;
  spotStart: boolean;
}

const CLEARED: Record<string, string> = { Y: 'Cleared', C: 'Cleared', I: 'To clear', N: 'Bilateral' };

/** New fixed-rate swap executions out of a batch of reports (amendments, terminations and options are dropped). */
export function swapPrints(trades: SdrTrade[]): SwapPrint[] {
  const out: SwapPrint[] = [];
  for (const t of trades) {
    const name = t.uniqueProductIdentifierShortName ?? '';
    if (t.actionType !== 'NEWT' || t.eventType !== 'TRAD' || !/Swap/i.test(name) || /Opt|Infl/i.test(name)) continue;
    const fixed = num(t.fixedRateLeg1 ?? '') ?? num(t.fixedRateLeg2 ?? '');
    if (fixed === null) continue;
    const eff = t.effectiveDate ?? '';
    const mat = t.expirationDate ?? '';
    const exec = t.executionTimestamp ?? t.eventTimestamp ?? '';
    const span = dayMs(mat) - dayMs(eff);
    const rawSize = t.notionalAmountLeg1 ?? '';
    out.push({
      time: exec,
      product: name.replace(/^NA\//, ''),
      currency: t.notionalCurrencyLeg1 ?? '',
      effective: eff,
      maturity: mat,
      tenorYears: Number.isFinite(span) && span > 0 ? Math.round((span / (365.25 * DAY)) * 100) / 100 : null,
      rate: Math.round(fixed * 100 * 1e5) / 1e5,
      notional: num(rawSize.replace(/\+$/, '')),
      capped: rawSize.trim().endsWith('+'),
      cleared: CLEARED[t.cleared ?? ''] ?? '',
      venue: t.platformIdentifier ?? '',
      spotStart: Number.isFinite(dayMs(eff)) && Math.abs(dayMs(eff) - dayMs(exec.slice(0, 10))) <= 10 * DAY,
    });
  }
  return out.sort((a, b) => b.time.localeCompare(a.time));
}

/** Spot-starting prints grouped by product and rounded tenor: count and median fixed rate. */
export function swapTenorSummary(prints: SwapPrint[]): Row[] {
  const groups = new Map<string, { product: string; tenor: number; rates: number[] }>();
  for (const p of prints) {
    if (!p.spotStart || p.tenorYears === null) continue;
    const tenor = p.tenorYears < 1.75 ? Math.round(p.tenorYears * 4) / 4 : Math.round(p.tenorYears);
    if (tenor <= 0) continue;
    const key = `${p.product}|${tenor}`;
    const g = groups.get(key) ?? { product: p.product, tenor, rates: [] };
    g.rates.push(p.rate);
    groups.set(key, g);
  }
  return [...groups.values()]
    .sort((a, b) => b.rates.length - a.rates.length || a.product.localeCompare(b.product) || a.tenor - b.tenor)
    .map((g) => ({ product: g.product, tenor: g.tenor, trades: g.rates.length, rate: Math.round((median(g.rates) as number) * 1e5) / 1e5, low: Math.min(...g.rates), high: Math.max(...g.rates) }));
}

const swapTrades: CardDef = {
  id: 'rates.swap-trades',
  title: 'Interest-Rate Swap Trade Prints',
  source: 'DTCC SDR',
  description: 'The latest publicly disseminated interest-rate swap executions (OIS and fixed-float) reported under CFTC rules: rate, tenor, size.',
  params: [{ name: 'currency', label: 'Currency', default: 'ALL', choices: ['ALL', 'USD', 'EUR', 'GBP', 'JPY', 'CAD', 'AUD', 'CHF'], hint: 'ALL or an ISO currency' }],
  async run(ctx, p) {
    const all = swapPrints(await sdrTrades(ctx, 'RATES'));
    const want = (p.currency ?? 'ALL').toUpperCase();
    const prints = want === 'ALL' ? all : all.filter((x) => x.currency === want);
    if (!prints.length) throw new SourceError('DTCC SDR', `no new ${want === 'ALL' ? '' : `${want} `}swap executions in the latest batch of reports; try currency=ALL`);
    const summary = swapTenorSummary(prints).slice(0, 12);
    const blocks: Block[] = [
      {
        kind: 'table',
        title: 'Latest executions',
        columns: [
          { key: 'time', label: 'Executed (UTC)', format: 'datetime' },
          { key: 'product', label: 'Product' },
          { key: 'tenor', label: 'Tenor (y)', format: 'num', digits: 2 },
          { key: 'rate', label: 'Fixed rate', format: 'pct', digits: 3 },
          { key: 'notional', label: 'Notional', format: 'compact' },
          { key: 'ccy', label: 'Ccy' },
          { key: 'effective', label: 'Start', format: 'date' },
          { key: 'maturity', label: 'Maturity', format: 'date' },
          { key: 'cleared', label: 'Clearing' },
          { key: 'venue', label: 'Venue' },
        ],
        rows: prints.slice(0, 40).map((x) => ({
          time: x.time,
          product: x.product,
          tenor: x.tenorYears,
          rate: x.rate,
          notional: x.notional,
          ccy: x.capped ? `${x.currency}+` : x.currency,
          effective: x.effective,
          maturity: x.maturity,
          cleared: x.cleared,
          venue: x.venue,
        })),
        footnote: 'A plus after the currency means the size is at the reporting cap, so the true notional is larger.',
      },
    ];
    if (summary.length) {
      blocks.push({
        kind: 'table',
        title: 'Spot-starting trades in this batch, by product and tenor',
        columns: [
          { key: 'product', label: 'Product' },
          { key: 'tenor', label: 'Tenor (y)', format: 'num', digits: 2 },
          { key: 'trades', label: 'Trades', format: 'int' },
          { key: 'rate', label: 'Median rate', format: 'pct', digits: 3 },
          { key: 'low', label: 'Low', format: 'pct', digits: 3 },
          { key: 'high', label: 'High', format: 'pct', digits: 3 },
        ],
        rows: summary,
      });
    }
    return {
      blocks,
      sourceUrl: SDR_URL,
      asOf: prints[0].time,
      notes: [
        'Trade reports from the DTCC swap data repository, disseminated in near real time under CFTC Part 43. The feed serves only the most recent hundred or so reports across all currencies, so this is a sample of the tape, not a full session.',
        'Venue is the execution platform code (XOFF or blank means off-facility). Forward-starting and package trades can print away from the spot market rate.',
      ],
    };
  },
};

// ---------- FOMC documents ----------

const FED = 'https://www.federalreserve.gov';

const ENTITIES: Record<string, string> = { amp: '&', nbsp: ' ', quot: '"', apos: "'", lt: '<', gt: '>', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', ndash: '–', mdash: '—', hellip: '…' };

export function htmlText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, n: string) => ENTITIES[n.toLowerCase()] ?? m)
    .replace(/[ \t\r\n]+/g, ' ')
    .trim();
}

export interface FomcDoc {
  date: string;
  kind: string;
  url: string;
}

const DOC_KINDS: [RegExp, string][] = [
  [/\/newsevents\/pressreleases\/monetary(\d{8})a\.htm/, 'Statement'],
  [/\/newsevents\/pressreleases\/monetary(\d{8})a1\.htm/, 'Implementation note'],
  [/\/monetarypolicy\/fomcminutes(\d{8})\.htm/, 'Minutes'],
  [/\/monetarypolicy\/fomcprojtabl(\d{8})\.htm/, 'Economic projections'],
  [/\/monetarypolicy\/fomcpresconf(\d{8})\.htm/, 'Press conference'],
];

/** Statement, minutes, projections and press-conference links on the Fed's FOMC calendar page, newest first. */
export function parseFomcCalendar(html: string): FomcDoc[] {
  const seen = new Set<string>();
  const out: FomcDoc[] = [];
  for (const m of html.matchAll(/href="([^"]+\.htm)"/g)) {
    const path = m[1].replace(/^https?:\/\/www\.federalreserve\.gov/, '');
    for (const [re, kind] of DOC_KINDS) {
      const hit = re.exec(path);
      if (!hit || seen.has(path)) continue;
      seen.add(path);
      const d = hit[1];
      out.push({ date: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`, kind, url: `${FED}${path}` });
    }
  }
  return out.sort((a, b) => b.date.localeCompare(a.date) || a.kind.localeCompare(b.kind));
}

/** The body paragraphs of a Federal Reserve press release page. */
export function parsePressRelease(html: string): { title: string; date: string; paragraphs: string[] } {
  const at = html.indexOf('id="article"');
  const body = at < 0 ? html : html.slice(at);
  const title = htmlText(/<h3[^>]*class="title"[^>]*>([\s\S]*?)<\/h3>/.exec(body)?.[1] ?? '');
  const date = htmlText(/<p[^>]*class="article__time"[^>]*>([\s\S]*?)<\/p>/.exec(body)?.[1] ?? '');
  const paragraphs: string[] = [];
  for (const m of body.matchAll(/<p(\s[^>]*)?>([\s\S]*?)<\/p>/g)) {
    if (/class="(article__time|releaseTime)/.test(m[1] ?? '')) continue;
    const text = htmlText(m[2]);
    if (/^For media inquiries/i.test(text)) break;
    if (/^(Implementation Note issued|Last Update:)/i.test(text)) continue;
    if (text.length > 40) paragraphs.push(text);
  }
  return { title, date, paragraphs };
}

async function fomcCalendar(ctx: Ctx): Promise<FomcDoc[]> {
  const html = await ctx.http.text(`${FED}/monetarypolicy/fomccalendars.htm`, { source: 'Federal Reserve', ttl: 3600, timeoutMs: 30_000 });
  const docs = parseFomcCalendar(html);
  if (!docs.length) throw new SourceError('Federal Reserve', 'no FOMC document links on the calendar page');
  return docs;
}

/** Items of the Fed's monetary-policy press release feed. */
export function parseFedRss(xml: string): { date: string; title: string; url: string }[] {
  const out: { date: string; title: string; url: string }[] = [];
  const cdata = (s: string | undefined) => (s ?? '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim();
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const item = m[1];
    const t = Date.parse(cdata(/<pubDate>([\s\S]*?)<\/pubDate>/.exec(item)?.[1]));
    out.push({
      date: Number.isNaN(t) ? '' : new Date(t).toISOString().slice(0, 10),
      title: htmlText(cdata(/<title>([\s\S]*?)<\/title>/.exec(item)?.[1])),
      url: cdata(/<link>([\s\S]*?)<\/link>/.exec(item)?.[1]),
    });
  }
  return out;
}

const fomcDocuments: CardDef = {
  id: 'rates.fomc-documents',
  title: 'FOMC Statements, Minutes and Projections',
  source: 'Federal Reserve',
  description: 'Links to recent FOMC statements, minutes, economic projections and press conferences, and the latest monetary policy press releases.',
  async run(ctx) {
    const docs = await fomcCalendar(ctx);
    const blocks: Block[] = [
      {
        kind: 'table',
        title: 'FOMC meeting documents, newest first',
        columns: [
          { key: 'date', label: 'Date', format: 'date' },
          { key: 'kind', label: 'Document' },
          { key: 'url', label: 'Link' },
        ],
        rows: docs.slice(0, 24).map((d) => ({ date: d.date, kind: d.kind, url: d.url })),
        footnote: 'Minutes are dated by their meeting and appear three weeks after it; projections accompany the March, June, September and December meetings.',
      },
    ];
    const notes: string[] = [];
    try {
      const items = parseFedRss(await ctx.http.text(`${FED}/feeds/press_monetary.xml`, { source: 'Federal Reserve', ttl: 1800 }));
      if (items.length) {
        blocks.push({
          kind: 'table',
          title: 'Monetary policy press releases',
          columns: [
            { key: 'date', label: 'Date', format: 'date' },
            { key: 'title', label: 'Release', maxWidth: 70 },
            { key: 'url', label: 'Link' },
          ],
          rows: items.slice(0, 12),
        });
      }
    } catch (e) {
      notes.push(`Press release feed unavailable (${(e as Error).message}).`);
    }
    return { blocks, sourceUrl: `${FED}/monetarypolicy/fomccalendars.htm`, asOf: docs[0].date, notes };
  },
};

const fomcStatement: CardDef = {
  id: 'rates.fomc-statement',
  title: 'Latest FOMC Statement',
  source: 'Federal Reserve',
  description: 'The full text of the most recent Federal Open Market Committee policy statement.',
  async run(ctx) {
    const today = ctx.now().toISOString().slice(0, 10);
    const latest = (await fomcCalendar(ctx)).find((d) => d.kind === 'Statement' && d.date <= today);
    if (!latest) throw new SourceError('Federal Reserve', 'no statement link on the FOMC calendar page');
    const page = parsePressRelease(await ctx.http.text(latest.url, { source: 'Federal Reserve', ttl: 21_600, timeoutMs: 30_000 }));
    if (!page.paragraphs.length) throw new SourceError('Federal Reserve', 'could not read the statement text');
    return {
      blocks: [{ kind: 'text', title: `${page.title || 'FOMC statement'} (${latest.date})`, text: page.paragraphs.join('\n\n') }],
      sourceUrl: latest.url,
      asOf: latest.date,
      notes: [
        'No market-implied policy path is shown: meeting-dated OIS and fed funds futures quotes are not available from a free public source that answers here, and a path built from scattered swap prints would not be reliable.',
      ],
    };
  },
};

export const swapPolicyCards: CardDef[] = [swapTrades, fomcStatement, fomcDocuments];
