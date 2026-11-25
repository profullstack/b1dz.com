/** Crypto news from publisher RSS feeds: headlines, a search across them, and longer research and protocol updates. */
import { SourceError, type CardDef } from '../../types.js';
import { foldHeadlines, type Headline } from '../macro/fold.js';
import { NEWS_COLUMNS, newest, newsRows, readFeeds, type FeedDef } from '../macro/news.js';

const HEADLINE_FEEDS: FeedDef[] = [
  { name: 'CoinDesk', url: 'https://www.coindesk.com/arc/outboundfeeds/rss/' },
  { name: 'Cointelegraph', url: 'https://cointelegraph.com/rss' },
  { name: 'The Block', url: 'https://www.theblock.co/rss.xml' },
  { name: 'Decrypt', url: 'https://decrypt.co/feed' },
  { name: 'DL News', url: 'https://www.dlnews.com/arc/outboundfeeds/rss/' },
  { name: 'CryptoSlate', url: 'https://cryptoslate.com/feed/' },
  { name: 'Protos', url: 'https://protos.com/feed/' },
  { name: 'The Defiant', url: 'https://thedefiant.io/api/feed' },
];

/** Extra feeds read only when searching, so a search for one coin has more to find. */
const SEARCH_FEEDS: FeedDef[] = [
  ...HEADLINE_FEEDS,
  { name: 'Cointelegraph', url: 'https://cointelegraph.com/rss/tag/bitcoin' },
  { name: 'Cointelegraph', url: 'https://cointelegraph.com/rss/tag/ethereum' },
  { name: 'Cointelegraph', url: 'https://cointelegraph.com/rss/tag/regulation' },
  { name: 'Cointelegraph', url: 'https://cointelegraph.com/rss/tag/defi' },
  { name: 'Bitcoinist', url: 'https://bitcoinist.com/feed/' },
  { name: 'NewsBTC', url: 'https://www.newsbtc.com/feed/' },
  { name: 'Cryptonews', url: 'https://cryptonews.com/news/feed/' },
  { name: 'AMBCrypto', url: 'https://ambcrypto.com/feed/' },
];

const RESEARCH_FEEDS: FeedDef[] = [
  { name: 'Ethereum Foundation', url: 'https://blog.ethereum.org/feed.xml' },
  { name: 'Bitcoin Optech', url: 'https://bitcoinops.org/feed.xml' },
  { name: 'Bankless', url: 'https://www.bankless.com/rss/feed' },
  { name: 'Unchained', url: 'https://unchainedcrypto.com/feed/' },
  { name: 'CFTC', url: 'https://www.cftc.gov/RSS/RSSGP/rssgp.xml' },
];

const names = (feeds: FeedDef[], failed: string[]) => [...new Set(feeds.map((f) => f.name))].filter((x) => !failed.includes(x)).join(', ');

const headlines: CardDef = {
  id: 'crypto.news',
  title: 'Crypto Headlines',
  source: 'Publisher RSS feeds',
  description: 'Crypto headlines merged from CoinDesk, Cointelegraph, The Block, Decrypt, DL News and others, newest first, with repeats folded.',
  async run(ctx) {
    const { items, failed } = await readFeeds(ctx, HEADLINE_FEEDS);
    const cutoff = ctx.now().getTime() + 3_600_000;
    const folded = foldHeadlines(items.filter((i) => i.date === null || i.date <= cutoff));
    const notes = [`${items.length} items from ${names(HEADLINE_FEEDS, failed)}; ${items.length - folded.length} repeats folded.`, 'A source shown as "Name +N" means N other publishers carried the same story.'];
    if (failed.length) notes.push(`Not answering now: ${failed.join(', ')}.`);
    return { blocks: [{ kind: 'table', columns: NEWS_COLUMNS, rows: newsRows(folded, 50) }], asOf: newest(folded), notes };
  },
};

/** Common names for the coins people search by symbol, so "BTC" also finds "Bitcoin". */
const ALIASES: Record<string, string[]> = {
  btc: ['bitcoin'],
  eth: ['ethereum', 'ether'],
  sol: ['solana'],
  xrp: ['ripple'],
  doge: ['dogecoin'],
  ada: ['cardano'],
  bnb: ['binance'],
  avax: ['avalanche'],
  link: ['chainlink'],
  ltc: ['litecoin'],
  dot: ['polkadot'],
  uni: ['uniswap'],
  hype: ['hyperliquid'],
  usdt: ['tether'],
  usdc: ['circle'],
  sec: ['securities and exchange commission'],
};

/** Headlines whose title holds every word of the query (or a known alias of it), as whole words. */
export function matchHeadlines(items: Headline[], query: string): Headline[] {
  const words = query.toLowerCase().replace(/-usd[tc]?$/, '').split(/\s+/).filter(Boolean);
  if (!words.length) return items;
  const tests = words.map((w) => {
    const alts = [w, ...(ALIASES[w] ?? [])].map((a) => a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    return new RegExp(`(^|[^a-z0-9])(${alts.join('|')})([^a-z0-9]|$)`, 'i');
  });
  return items.filter((i) => tests.every((t) => t.test(i.title)));
}

const search: CardDef = {
  id: 'crypto.news-search',
  title: 'News on a Coin or Topic',
  source: 'Publisher RSS feeds',
  description: 'Recent crypto headlines that mention a coin or a topic: a symbol (BTC, SOL), a name (Ethereum) or words such as ETF, stablecoin or SEC.',
  params: [{ name: 'symbol', label: 'Coin or topic', default: 'BTC-USD', hint: 'BTC, Solana, ETF, stablecoin, SEC' }],
  async run(ctx, params) {
    const query = (params.symbol ?? 'BTC').trim();
    const { items, failed } = await readFeeds(ctx, SEARCH_FEEDS);
    const now = ctx.now().getTime();
    const hits = matchHeadlines(items.filter((i) => i.date !== null && i.date <= now + 3_600_000 && i.date >= now - 30 * 86_400_000), query);
    const shown = query.replace(/-USD[TC]?$/i, '');
    if (!hits.length) throw new SourceError('Publisher RSS feeds', `no headline in the last 30 days mentions "${shown}"`);
    const folded = foldHeadlines(hits);
    const notes = [`${folded.length} of ${items.length} current feed items mention "${shown}". Feeds: ${names(SEARCH_FEEDS, failed)}.`, 'Feeds carry only each publisher\'s latest stories, so this usually reaches back a few days; items older than 30 days are dropped.'];
    if (failed.length) notes.push(`Not answering now: ${failed.join(', ')}.`);
    return { blocks: [{ kind: 'table', columns: NEWS_COLUMNS, rows: newsRows(folded, 50) }], asOf: newest(folded), notes };
  },
};

const research: CardDef = {
  id: 'crypto.news-research',
  title: 'Research and Protocol Updates',
  source: 'Publisher RSS feeds',
  description: 'Longer reads and primary sources: the Ethereum Foundation blog, Bitcoin Optech, Bankless, Unchained and CFTC press releases.',
  async run(ctx) {
    const { items, failed } = await readFeeds(ctx, RESEARCH_FEEDS);
    const cutoff = ctx.now().getTime() + 86_400_000;
    const folded = foldHeadlines(items.filter((i) => i.date === null || i.date <= cutoff), 0.9);
    const notes = [`Feeds: ${names(RESEARCH_FEEDS, failed)}.`];
    if (failed.length) notes.push(`Not answering now: ${failed.join(', ')}.`);
    return { blocks: [{ kind: 'table', columns: NEWS_COLUMNS, rows: newsRows(folded, 50) }], asOf: newest(folded), notes };
  },
};

export const cryptoNewsCards: CardDef[] = [headlines, search, research];
