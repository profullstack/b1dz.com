/** Company > Overview: price chart, business snapshot, analyst targets, consensus history, news. */
import { NICHEDB_NEWS, nichedbNews } from '../../lib/nichedb.js';
import { pctChange } from '../../format.js';
import { num } from '../../http.js';
import { getHistory, getQuote, RANGES, type Range } from '../../lib/market.js';
import { NASDAQ, nasdaqGet, nasdaqInfo, nasdaqSymbol, parseTrade } from '../../lib/nasdaq.js';
import { SourceError, type CardDef, type Row, type StatItem } from '../../types.js';
import { longDate, SYMBOL, symbolOf } from './util.js';

const RANGE = { name: 'range', label: 'Range', default: '1Y', choices: RANGES as string[] };

function stockUrl(symbol: string, cls: string, page = ''): string {
  return `https://www.nasdaq.com/market-activity/${cls === 'etf' ? 'etf' : 'stocks'}/${nasdaqSymbol(symbol).toLowerCase()}${page}`;
}

const priceHistory: CardDef = {
  id: 'equities.price-history',
  title: 'Price history',
  source: NASDAQ,
  description: 'Daily closes for a symbol over a chosen range, with the high, low and return for the period.',
  params: [SYMBOL, RANGE],
  async run(ctx, params) {
    const symbol = symbolOf(params);
    const range = (RANGES.includes(params.range as Range) ? params.range : '1Y') as Range;
    const h = await getHistory(ctx, symbol, range);
    const bars = h.bars;
    const first = bars[0];
    const last = bars[bars.length - 1];
    const hi = bars.reduce((a, b) => (b.h > a.h ? b : a));
    const lo = bars.reduce((a, b) => (b.l < a.l ? b : a));
    const items: StatItem[] = [
      { label: 'Last close', value: last.c, format: 'num' },
      { label: `Return (${range})`, value: pctChange(last.c, first.c), format: 'signedPct' },
      { label: 'Period high', value: hi.h, format: 'num' },
      { label: 'High date', value: hi.t, format: 'date' },
      { label: 'Period low', value: lo.l, format: 'num' },
      { label: 'Low date', value: lo.t, format: 'date' },
      { label: 'From', value: first.t, format: 'date' },
      { label: 'Trading days', value: bars.length, format: 'int' },
    ];
    return {
      blocks: [
        { kind: 'chart', title: `${symbol} daily close`, xType: 'time', series: [{ name: symbol, points: bars.map((b) => [b.t, b.c]) }], yFormat: 'num' },
        { kind: 'stats', items },
      ],
      source: h.source,
      asOf: new Date(last.t).toISOString().slice(0, 10),
      notes: ['Closes are split-adjusted and not dividend-adjusted (price return).', ...(range === 'MAX' && h.source === NASDAQ ? ['Nasdaq keeps about ten years of daily history.'] : [])],
    };
  },
};

interface Summary {
  summaryData?: Record<string, { label?: string; value?: string } | undefined>;
}
interface Profile {
  [k: string]: { label?: string; value?: string | null } | undefined;
}
interface Eps {
  earningsPerShare?: { type?: string; period?: string; consensus?: number; earnings?: number }[];
}

const snapshot: CardDef = {
  id: 'equities.snapshot',
  title: 'Business snapshot',
  source: NASDAQ,
  description: 'Name, sector, industry, market value, trailing P/E and EPS, dividend yield, 52-week range and volume.',
  params: [SYMBOL],
  async run(ctx, params) {
    const symbol = symbolOf(params);
    const { info, cls } = await nasdaqInfo(ctx, symbol);
    const sym = encodeURIComponent(nasdaqSymbol(symbol));
    const [summary, profile, eps] = await Promise.all([
      nasdaqGet<Summary>(ctx, `/api/quote/${sym}/summary?assetclass=${cls}`, 300),
      cls === 'stocks' ? nasdaqGet<Profile>(ctx, `/api/company/${sym}/company-profile`, 21_600).catch(() => null) : null,
      cls === 'stocks' ? nasdaqGet<Eps>(ctx, `/api/quote/${sym}/eps`, 3600).catch(() => null) : null,
    ]);
    const s = summary.summaryData ?? {};
    const val = (k: string): string | undefined => {
      const v = s[k]?.value;
      return v && v !== 'N/A' ? v : undefined;
    };
    const trade = parseTrade(info.primaryData);
    const close = parseTrade(info.secondaryData).price ?? num(val('PreviousClose')) ?? trade.price;
    const reported = (eps?.earningsPerShare ?? []).filter((e) => e.type === 'PreviousQuarter' && typeof e.earnings === 'number');
    const ttmEps = reported.length >= 4 ? reported.slice(-4).reduce((a, e) => a + (e.earnings ?? 0), 0) : null;
    const [hi52, lo52] = (val('FiftTwoWeekHighLow') ?? '').split('/').map((x) => num(x));
    const items: StatItem[] = [
      { label: 'Name', value: profile?.CompanyName?.value ?? info.companyName },
      { label: 'Exchange', value: val('Exchange') ?? info.exchange },
      { label: 'Sector', value: val('Sector') ?? profile?.Sector?.value },
      { label: 'Industry', value: val('Industry') ?? profile?.Industry?.value },
      { label: 'Last', value: trade.price, format: 'usd' },
      { label: 'Change', value: trade.changePct, format: 'signedPct' },
      { label: 'Market cap', value: num(val('MarketCap')), format: 'usdCompact' },
      { label: 'P/E (trailing)', value: ttmEps && ttmEps > 0 && close ? close / ttmEps : null, format: 'num', digits: 1 },
      { label: 'EPS (trailing 4Q)', value: ttmEps, format: 'usd' },
      { label: 'Dividend yield', value: num(val('Yield')), format: 'pct' },
      { label: 'Annual dividend', value: num(val('AnnualizedDividend')), format: 'usd' },
      { label: 'Ex-dividend date', value: longDate(val('ExDividendDate')) },
      { label: '52-week high', value: hi52 ?? null, format: 'usd' },
      { label: '52-week low', value: lo52 ?? null, format: 'usd' },
      { label: 'Volume', value: num(val('ShareVolume')), format: 'compact' },
      { label: '1-year target', value: num(val('OneYrTarget')), format: 'usd' },
    ].filter((i) => i.value !== undefined && i.value !== null && i.value !== '') as StatItem[];
    const about = profile?.CompanyDescription?.value;
    return {
      blocks: [{ kind: 'stats', items }, ...(about ? [{ kind: 'text' as const, title: 'About', text: about.trim() }] : [])],
      sourceUrl: stockUrl(symbol, cls),
      asOf: trade.time,
      notes: [
        `Quote status: ${info.marketStatus ?? 'unknown'}; ${info.primaryData?.isRealTime ? 'last sale from Nasdaq' : 'delayed'}.`,
        ...(ttmEps !== null ? ['Trailing EPS is the sum of the last four reported quarters on the analyst-consensus basis (Zacks via Nasdaq), which can differ from GAAP diluted EPS.'] : []),
      ],
    };
  },
};

interface TargetPrice {
  consensusOverview?: { lowPriceTarget?: number; highPriceTarget?: number; priceTarget?: number; buy?: number; sell?: number; hold?: number };
  historicalConsensus?: { x?: number; y?: number; z?: { buy?: number; hold?: number; sell?: number; date?: string; consensus?: string } }[];
}
interface Ratings {
  meanRatingType?: string;
  ratingsSummary?: string;
  brokerNames?: string[];
}

async function targets(ctx: Parameters<CardDef['run']>[0], symbol: string): Promise<TargetPrice> {
  const t = await nasdaqGet<TargetPrice>(ctx, `/api/analyst/${encodeURIComponent(nasdaqSymbol(symbol))}/targetprice`, 3600);
  if (!t.consensusOverview && !t.historicalConsensus?.length) throw new SourceError(NASDAQ, `no analyst coverage for ${symbol}`);
  return t;
}

const analystTargets: CardDef = {
  id: 'equities.analyst-targets',
  title: 'Analyst price targets and consensus',
  source: NASDAQ,
  description: 'Low, mean and high 12-month price targets, the buy/hold/sell split and the implied upside.',
  params: [SYMBOL],
  async run(ctx, params) {
    const symbol = symbolOf(params);
    const [t, r, q] = await Promise.all([
      targets(ctx, symbol),
      nasdaqGet<Ratings>(ctx, `/api/analyst/${encodeURIComponent(nasdaqSymbol(symbol))}/ratings`, 3600).catch(() => null),
      getQuote(ctx, symbol).catch(() => null),
    ]);
    const c = t.consensusOverview ?? {};
    const total = (c.buy ?? 0) + (c.hold ?? 0) + (c.sell ?? 0);
    const items: StatItem[] = [
      { label: 'Consensus', value: r?.meanRatingType },
      { label: 'Mean target', value: c.priceTarget, format: 'usd' },
      { label: 'Upside to mean', value: pctChange(c.priceTarget, q?.price), format: 'signedPct' },
      { label: 'High target', value: c.highPriceTarget, format: 'usd' },
      { label: 'Low target', value: c.lowPriceTarget, format: 'usd' },
      { label: 'Last price', value: q?.price, format: 'usd' },
      { label: 'Buy', value: c.buy, format: 'int' },
      { label: 'Hold', value: c.hold, format: 'int' },
      { label: 'Sell', value: c.sell, format: 'int' },
      { label: 'Buy share', value: total ? ((c.buy ?? 0) / total) * 100 : null, format: 'pct', digits: 0 },
    ];
    const hist = (t.historicalConsensus ?? []).filter((h) => typeof h.x === 'number' && typeof h.y === 'number');
    return {
      blocks: [
        { kind: 'stats', items },
        ...(hist.length > 1 ? [{ kind: 'chart' as const, title: 'Mean price target', xType: 'time' as const, series: [{ name: 'Mean target', points: hist.map((h) => [h.x! * 1000, h.y!] as [number, number]) }], yFormat: 'usd' as const }] : []),
      ],
      sourceUrl: stockUrl(symbol, 'stocks', '/analyst-research'),
      notes: [r?.ratingsSummary ?? 'Analyst data is compiled by Nasdaq from broker research.'].filter(Boolean),
    };
  },
};

const ratingChanges: CardDef = {
  id: 'equities.rating-changes',
  title: 'Consensus rating changes',
  source: NASDAQ,
  description: 'Month by month: how many analysts rate the stock buy, hold or sell, the consensus label and the mean target.',
  params: [SYMBOL],
  async run(ctx, params) {
    const symbol = symbolOf(params);
    const t = await targets(ctx, symbol);
    const hist = (t.historicalConsensus ?? []).filter((h) => typeof h.x === 'number').sort((a, b) => b.x! - a.x!);
    if (!hist.length) throw new SourceError(NASDAQ, `no consensus history for ${symbol}`);
    const rows: Row[] = hist.map((h, i) => {
      const prev = hist[i + 1];
      return {
        date: new Date(h.x! * 1000).toISOString().slice(0, 10),
        consensus: h.z?.consensus,
        buy: h.z?.buy,
        hold: h.z?.hold,
        sell: h.z?.sell,
        buyChg: prev && h.z?.buy != null && prev.z?.buy != null ? h.z.buy - prev.z.buy : null,
        target: h.y,
        targetChg: prev ? pctChange(h.y, prev.y) : null,
      };
    });
    return {
      blocks: [
        {
          kind: 'table',
          columns: [
            { key: 'date', label: 'Month' },
            { key: 'consensus', label: 'Consensus' },
            { key: 'buy', label: 'Buy', format: 'int' },
            { key: 'hold', label: 'Hold', format: 'int' },
            { key: 'sell', label: 'Sell', format: 'int' },
            { key: 'buyChg', label: 'Buy chg', format: 'signed', digits: 0 },
            { key: 'target', label: 'Mean target', format: 'usd' },
            { key: 'targetChg', label: 'Target chg', format: 'signedPct' },
          ],
          rows,
        },
      ],
      sourceUrl: stockUrl(symbol, 'stocks', '/analyst-research'),
      asOf: String(rows[0].date),
      notes: ['Monthly snapshots of the analyst consensus. Individual broker upgrades and downgrades are not published by this source.'],
    };
  },
};

const news: CardDef = {
  id: 'equities.news',
  title: 'Company news',
  source: NICHEDB_NEWS,
  description: 'Latest headlines tagged to the symbol, linking to the original publisher.',
  params: [SYMBOL],
  async run(ctx, params) {
    const symbol = symbolOf(params);
    const list = await nichedbNews(ctx, symbol, 25);
    if (!list.length) throw new SourceError(NICHEDB_NEWS, `no news for ${symbol}`);
    return {
      blocks: [
        {
          kind: 'table',
          columns: [
            { key: 'date', label: 'Published (UTC)', format: 'datetime' },
            { key: 'title', label: 'Headline', maxWidth: 90 },
            { key: 'publisher', label: 'Publisher', maxWidth: 22 },
            { key: 'url', label: 'Link', maxWidth: 60 },
          ],
          rows: list.map((h): Row => ({ date: h.t, title: h.title, publisher: h.publisher, url: h.url })),
        },
      ],
      asOf: list[0].t ? new Date(list[0].t).toISOString().slice(0, 16).replace('T', ' ') : undefined,
      notes: ['Headlines link to the original publisher; some publishers ask for a subscription.'],
    };
  },
};

export const overviewCards: CardDef[] = [priceHistory, snapshot, analystTargets, ratingChanges, news];
