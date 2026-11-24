/** News: market headlines, official releases, company headlines and country news, all from published feeds. */
import { isoDate } from '../../format.js';
import { cikFor, filingIndexUrl, submissions } from '../../lib/sec.js';
import { SourceError, type Block, type CardDef, type Column, type Ctx, type DashboardDef, type Row } from '../../types.js';
import { resolveEconomy } from './countries.js';
import { foldHeadlines, type FoldedHeadline, type Headline } from './fold.js';
import { parseFeed } from './rss.js';

interface FeedDef {
  /** Publisher shown in the Source column. */
  name: string;
  url: string;
  /** Sent instead of the default browser user-agent, for hosts that refuse it. */
  agent?: string;
}

const READER_AGENT = 'b1dz-research/0.4 (+https://b1dz.com)';

const MARKET_FEEDS: FeedDef[] = [
  { name: 'MarketWatch', url: 'https://feeds.content.dowjones.io/public/rss/mw_topstories' },
  { name: 'MarketWatch', url: 'https://feeds.content.dowjones.io/public/rss/mw_marketpulse' },
  { name: 'CNBC', url: 'https://www.cnbc.com/id/100003114/device/rss/rss.html' },
  { name: 'CNBC', url: 'https://www.cnbc.com/id/20910258/device/rss/rss.html' },
  { name: 'BBC', url: 'https://feeds.bbci.co.uk/news/business/rss.xml' },
  { name: 'Financial Times', url: 'https://www.ft.com/markets?format=rss' },
  { name: 'Nasdaq', url: 'https://www.nasdaq.com/feed/rssoutbound?category=Markets' },
  { name: 'Nikkei Asia', url: 'https://asia.nikkei.com/rss/feed/nar' },
  { name: 'France 24', url: 'https://www.france24.com/en/business/rss' },
  { name: 'NPR', url: 'https://feeds.npr.org/1006/rss.xml' },
];

const OFFICIAL_FEEDS: FeedDef[] = [
  { name: 'Federal Reserve', url: 'https://www.federalreserve.gov/feeds/press_all.xml' },
  { name: 'Federal Reserve (speeches)', url: 'https://www.federalreserve.gov/feeds/speeches.xml' },
  { name: 'ECB', url: 'https://www.ecb.europa.eu/rss/press.html' },
  { name: 'Bank of England', url: 'https://www.bankofengland.co.uk/rss/news' },
  { name: 'Bank of Japan', url: 'https://www.boj.or.jp/en/rss/whatsnew.xml' },
  { name: 'Bank of Canada', url: 'https://www.bankofcanada.ca/content_type/press-releases/feed/' },
  { name: 'BIS', url: 'https://www.bis.org/doclist/all_pressrels.rss' },
  { name: 'BIS (central bank speeches)', url: 'https://www.bis.org/doclist/cbspeeches.rss' },
  { name: 'SEC', url: 'https://www.sec.gov/news/pressreleases.rss' },
  { name: 'BEA', url: 'https://apps.bea.gov/rss/rss.xml' },
  { name: 'BLS', url: 'https://www.bls.gov/feed/bls_latest.rss', agent: READER_AGENT },
  { name: 'Census Bureau', url: 'https://www.census.gov/economic-indicators/indicator.xml' },
];

async function readFeed(ctx: Ctx, feed: FeedDef, ttl = 300): Promise<Headline[]> {
  const xml = await ctx.http.text(feed.url, {
    source: feed.name.replace(/\s*\(.*\)$/, ''),
    ttl,
    timeoutMs: 15_000,
    headers: { accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*', ...(feed.agent ? { 'user-agent': feed.agent } : {}) },
  });
  const parsed = parseFeed(xml);
  if (!parsed.items.length) throw new SourceError(feed.name, 'the feed has no items');
  return parsed.items.filter((i) => i.title).map((i) => ({ title: i.title, link: i.link, source: feed.name, date: i.date }));
}

/** Read every feed; a feed that fails is named in `failed` rather than failing the card. */
async function readFeeds(ctx: Ctx, feeds: FeedDef[]): Promise<{ items: Headline[]; failed: string[]; answered: number }> {
  const got = await Promise.allSettled(feeds.map((f) => readFeed(ctx, f)));
  const items: Headline[] = [];
  const failed: string[] = [];
  let answered = 0;
  got.forEach((g, i) => {
    if (g.status === 'fulfilled') {
      answered++;
      items.push(...g.value);
    } else if (!failed.includes(feeds[i].name)) failed.push(feeds[i].name);
  });
  if (!answered) {
    const first = got[0];
    throw first.status === 'rejected' && first.reason instanceof Error ? first.reason : new SourceError('News feeds', 'no feed answered');
  }
  return { items, failed, answered };
}

const NEWS_COLUMNS: Column[] = [
  { key: 'time', label: 'Time (UTC)', format: 'datetime' },
  { key: 'title', label: 'Headline', maxWidth: 90 },
  { key: 'source', label: 'Source', maxWidth: 30 },
  { key: 'link', label: 'Link', maxWidth: 40 },
];

function newsRows(items: FoldedHeadline[], limit: number): Row[] {
  return items.slice(0, limit).map((h) => ({
    time: h.date,
    title: h.title,
    source: h.sources.length > 1 ? `${h.sources[0]} +${h.sources.length - 1}` : h.source,
    link: h.link,
  }));
}

function newest(items: { date: number | null }[]): string | undefined {
  const t = items.reduce<number | null>((m, i) => (i.date !== null && (m === null || i.date > m) ? i.date : m), null);
  return t === null ? undefined : new Date(t).toISOString().slice(0, 16) + 'Z';
}

const markets: CardDef = {
  id: 'macro.news-markets',
  title: 'Market Headlines',
  source: 'Publisher RSS feeds',
  description: 'Market and business headlines merged from several publishers, newest first, with repeated stories folded into one row.',
  async run(ctx) {
    const { items, failed } = await readFeeds(ctx, MARKET_FEEDS);
    // Ignore items dated in the future (a publisher clock error would pin them to the top).
    const cutoff = ctx.now().getTime() + 3_600_000;
    const folded = foldHeadlines(items.filter((i) => i.date === null || i.date <= cutoff));
    const notes = [`${items.length} items from ${[...new Set(MARKET_FEEDS.map((f) => f.name))].filter((n) => !failed.includes(n)).join(', ')}; ${items.length - folded.length} repeats folded.`, 'A source shown as "Name +N" means N other publishers carried the same story.'];
    if (failed.length) notes.push(`Not answering now: ${failed.join(', ')}.`);
    return { blocks: [{ kind: 'table', columns: NEWS_COLUMNS, rows: newsRows(folded, 40) }], asOf: newest(folded), notes };
  },
};

const official: CardDef = {
  id: 'macro.news-official',
  title: 'Official Releases',
  source: 'Central banks and agencies',
  description: 'Press releases, speeches and data releases from central banks, regulators and statistical agencies.',
  async run(ctx) {
    const { items, failed } = await readFeeds(ctx, OFFICIAL_FEEDS);
    const cutoff = ctx.now().getTime() + 86_400_000;
    const folded = foldHeadlines(items.filter((i) => i.date === null || i.date <= cutoff), 0.9);
    const notes = ['Feeds: Federal Reserve, ECB, Bank of England, Bank of Japan, Bank of Canada, BIS, SEC, BEA, BLS and the Census Bureau.', 'The IMF and the U.S. Treasury publish no feed that answers automated readers, so they are not included.'];
    if (failed.length) notes.push(`Not answering now: ${failed.join(', ')}.`);
    return { blocks: [{ kind: 'table', columns: NEWS_COLUMNS, rows: newsRows(folded, 40) }], asOf: newest(folded), notes };
  },
};

interface NasdaqNews {
  data?: { rows?: { title?: string; created?: string; ago?: string; publisher?: string; url?: string }[] | null } | null;
  status?: { rCode?: number; bCodeMessage?: { errorMessage?: string }[] | null };
}

/** Rows of Nasdaq's per-symbol news response. Dates are day-precision ("Nov 24, 2026"). */
export function parseNasdaqNews(body: NasdaqNews): Row[] {
  const rows: Row[] = [];
  for (const r of body.data?.rows ?? []) {
    if (!r.title) continue;
    const t = r.created ? Date.parse(`${r.created} UTC`) : NaN;
    rows.push({
      date: Number.isNaN(t) ? (r.created ?? null) : isoDate(t),
      age: r.ago ?? null,
      title: r.title.trim(),
      source: r.publisher ?? null,
      link: r.url ? (r.url.startsWith('http') ? r.url : `https://www.nasdaq.com${r.url}`) : null,
    });
  }
  return rows;
}

/** What the numbered items of a Form 8-K report. */
const ITEMS_8K: Record<string, string> = {
  '1.01': 'Material agreement', '1.02': 'Agreement terminated', '1.03': 'Bankruptcy', '1.05': 'Cybersecurity incident',
  '2.01': 'Acquisition or disposal', '2.02': 'Results of operations', '2.03': 'New financial obligation', '2.04': 'Obligation accelerated',
  '2.05': 'Exit or restructuring costs', '2.06': 'Impairment', '3.01': 'Delisting notice', '3.02': 'Unregistered share sale',
  '3.03': 'Change to holder rights', '4.01': 'Auditor change', '4.02': 'Prior statements unreliable', '5.01': 'Change in control',
  '5.02': 'Director or officer change', '5.03': 'Bylaw or fiscal-year change', '5.07': 'Shareholder vote', '7.01': 'Regulation FD disclosure',
  '8.01': 'Other events', '9.01': 'Exhibits',
};

/** "2.02,9.01" -> "Results of operations; Exhibits". Unknown item numbers are kept as written. */
export function describe8kItems(items: string): string {
  return items
    .split(',')
    .map((i) => i.trim())
    .filter(Boolean)
    .map((i) => ITEMS_8K[i] ?? `Item ${i}`)
    .join('; ');
}

const company: CardDef = {
  id: 'macro.news-company',
  title: 'Company News',
  source: 'Nasdaq, SEC EDGAR',
  description: 'Recent headlines for a U.S.-listed company, and its latest 8-K current reports.',
  params: [{ name: 'symbol', label: 'Symbol', default: 'AAPL', hint: 'U.S. ticker, e.g. AAPL' }],
  async run(ctx, p) {
    const symbol = (p.symbol ?? 'AAPL').trim().toUpperCase();
    if (!/^[A-Z0-9.\-]{1,10}$/.test(symbol)) throw new SourceError('Nasdaq', `not a ticker: ${p.symbol}`);
    const nasdaqUrl = `https://api.nasdaq.com/api/news/topic/articlebysymbol?q=${encodeURIComponent(`${symbol.toLowerCase()}|stocks`)}&offset=0&limit=25&fallback=false`;
    const eightK = async (): Promise<Row[]> => {
      const reg = await cikFor(ctx, symbol);
      const sub = await submissions(ctx, reg.cik);
      return sub.filings
        .filter((f) => f.form === '8-K' || f.form === '8-K/A')
        .slice(0, 15)
        .map((f) => ({ date: f.filingDate, form: f.form, items: describe8kItems(f.items), link: filingIndexUrl(reg.cik, f.accession) }));
    };
    const [news, filings] = await Promise.allSettled([ctx.http.json<NasdaqNews>(nasdaqUrl, { source: 'Nasdaq', ttl: 300 }).then(parseNasdaqNews), eightK()]);
    const blocks: Block[] = [];
    const notes: string[] = [];
    const sources: string[] = [];
    if (news.status === 'fulfilled' && news.value.length) {
      sources.push('Nasdaq');
      blocks.push({
        kind: 'table',
        title: `${symbol}: headlines`,
        columns: [{ key: 'date', label: 'Date' }, { key: 'age', label: 'Age' }, { key: 'title', label: 'Headline', maxWidth: 90 }, { key: 'source', label: 'Publisher', maxWidth: 24 }, { key: 'link', label: 'Link', maxWidth: 40 }],
        rows: news.value,
      });
    } else notes.push(`Nasdaq headlines unavailable (${news.status === 'rejected' ? (news.reason as Error).message : 'none for this symbol'}).`);
    if (filings.status === 'fulfilled' && filings.value.length) {
      sources.push('SEC EDGAR');
      blocks.push({
        kind: 'table',
        title: `${symbol}: 8-K current reports`,
        columns: [{ key: 'date', label: 'Filed' }, { key: 'form', label: 'Form' }, { key: 'items', label: 'Reports', maxWidth: 90 }, { key: 'link', label: 'Link', maxWidth: 50 }],
        rows: filings.value,
      });
    } else notes.push(`SEC 8-K filings unavailable (${filings.status === 'rejected' ? (filings.reason as Error).message : 'none for this symbol'}).`);
    if (!blocks.length) throw new SourceError('Nasdaq', `no headlines or filings for ${symbol}`);
    notes.push('Nasdaq dates are day-precision. 8-K reports are the filings companies must make for material events.');
    return { blocks, source: sources.join(', '), sourceUrl: `https://www.nasdaq.com/market-activity/stocks/${symbol.toLowerCase()}/news-headlines`, notes };
  },
};

/** Google News titles end " - Publisher": split it off so the publisher becomes the source. */
export function splitPublisher(title: string): { title: string; publisher: string | null } {
  const i = title.lastIndexOf(' - ');
  if (i <= 0 || title.length - i > 60) return { title, publisher: null };
  return { title: title.slice(0, i).trim(), publisher: title.slice(i + 3).trim() };
}

const regional: CardDef = {
  id: 'macro.news-regional',
  title: 'Country News',
  source: 'Google News',
  description: 'Economy and markets headlines about one country, newest first.',
  params: [{ name: 'country', label: 'Country', default: 'US', hint: 'ISO-2 code, e.g. US, DE, JP, or XM for the euro area' }],
  async run(ctx, p) {
    const eco = resolveEconomy(p.country);
    const subject = eco.iso2 === 'XM' ? 'eurozone' : `"${eco.name}"`;
    const q = encodeURIComponent(`${subject} economy OR markets OR "central bank" when:7d`);
    const url = `https://news.google.com/rss/search?q=${q}&hl=en-US&gl=US&ceid=US:en`;
    const xml = await ctx.http.text(url, { source: 'Google News', ttl: 600, timeoutMs: 15_000 });
    const items: Headline[] = parseFeed(xml).items.map((i) => {
      const s = splitPublisher(i.title);
      return { title: s.title, link: i.link, source: s.publisher ?? 'Google News', date: i.date };
    });
    if (!items.length) throw new SourceError('Google News', `no headlines for ${eco.name}`);
    const folded = foldHeadlines(items);
    return {
      blocks: [{ kind: 'table', title: `${eco.name}: economy and markets`, columns: NEWS_COLUMNS, rows: newsRows(folded, 30) }],
      sourceUrl: `https://news.google.com/search?q=${q}`,
      asOf: newest(folded),
      notes: ['Headlines from the last seven days, as indexed by Google News; links open through Google News.'],
    };
  },
};

export const newsCards: CardDef[] = [markets, official, company, regional];

export const newsDashboard: DashboardDef = {
  id: 'news',
  title: 'News',
  group: 'News & Research',
  tabs: [
    { id: 'markets', title: 'Markets', cards: ['macro.news-markets'] },
    { id: 'official', title: 'Official', cards: ['macro.news-official'] },
    { id: 'company', title: 'Company', cards: ['macro.news-company'] },
    { id: 'regional', title: 'Regional', cards: ['macro.news-regional'] },
  ],
};
