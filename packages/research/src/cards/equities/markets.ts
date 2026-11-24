/** Canada (TMX) and the Nordics (Nasdaq Nordic). */
import { pctChange } from '../../format.js';
import { num } from '../../http.js';
import { getQuotes, returnsBoard, tmxQuery, tmxSymbol } from '../../lib/market.js';
import { SourceError, type CardDef, type Ctx, type Row, type StatItem } from '../../types.js';

// ---------------------------------------------------------------- Canada

const TMX = 'TMX Money';

const CA_INDICES = [
  { symbol: '^GSPTSE', label: 'S&P/TSX Composite' },
  { symbol: '^TX60', label: 'S&P/TSX 60' },
  { symbol: '^JX', label: 'S&P/TSX Venture Composite' },
];

const CA_LISTINGS: [string, string][] = [
  ['RY', 'Royal Bank of Canada'], ['TD', 'Toronto-Dominion Bank'], ['SHOP', 'Shopify'], ['ENB', 'Enbridge'], ['BN', 'Brookfield'],
  ['BMO', 'Bank of Montreal'], ['CNQ', 'Canadian Natural Resources'], ['CP', 'Canadian Pacific Kansas City'], ['BNS', 'Bank of Nova Scotia'], ['CM', 'CIBC'],
  ['CNR', 'Canadian National Railway'], ['TRI', 'Thomson Reuters'], ['MFC', 'Manulife'], ['TRP', 'TC Energy'], ['SU', 'Suncor Energy'],
  ['CSU', 'Constellation Software'], ['ATD', 'Alimentation Couche-Tard'], ['AEM', 'Agnico Eagle Mines'], ['ABX', 'Barrick'], ['NTR', 'Nutrien'],
  ['WCN', 'Waste Connections'], ['BCE', 'BCE'], ['T', 'Telus'], ['L', 'Loblaw'], ['CCO', 'Cameco'],
];

const canadaIndices: CardDef = {
  id: 'equities.canada-indices',
  title: 'Canadian indices',
  source: TMX,
  description: 'S&P/TSX Composite, TSX 60 and TSX Venture: last close and returns over one week to one year.',
  async run(ctx) {
    const b = await returnsBoard(ctx, CA_INDICES);
    return { blocks: [b.block], source: b.source, sourceUrl: 'https://money.tmx.com/en/canadian-markets', notes: [...b.notes, 'Index levels in Canadian dollars.'] };
  },
};

const canadaBoard: CardDef = {
  id: 'equities.canada-board',
  title: 'Major TSX listings',
  source: TMX,
  description: 'Twenty-five of the largest Toronto Stock Exchange companies: last close and returns over one week to one year.',
  async run(ctx) {
    const b = await returnsBoard(ctx, CA_LISTINGS.map(([s, label]) => ({ symbol: `${s}.TO`, label })));
    return { blocks: [b.block], source: b.source, sourceUrl: 'https://money.tmx.com/en/canadian-markets', notes: [...b.notes, 'Prices in Canadian dollars on the Toronto Stock Exchange. A fixed list of large companies, not an index.'] };
  },
};

interface TmxQuote {
  symbol?: string;
  name?: string;
  price?: number | null;
  priceChange?: number | null;
  percentChange?: number | null;
  exchangeName?: string;
  volume?: number | null;
  prevClose?: number | null;
  openPrice?: number | null;
  dayHigh?: number | null;
  dayLow?: number | null;
  weeks52high?: number | null;
  weeks52low?: number | null;
  MarketCap?: number | null;
  peRatio?: number | null;
  eps?: number | null;
  dividendYield?: number | null;
  dividendAmount?: number | null;
  dividendFrequency?: string | null;
  exDividendDate?: string | null;
  beta?: number | null;
  sector?: string | null;
  industry?: string | null;
  shortDescription?: string | null;
}

const QUOTE_FIELDS = 'symbol name price priceChange percentChange exchangeName volume prevClose openPrice dayHigh dayLow weeks52high weeks52low MarketCap peRatio eps dividendYield dividendAmount dividendFrequency exDividendDate beta sector industry shortDescription';

const canadaQuote: CardDef = {
  id: 'equities.canada-quote',
  title: 'Canadian listing snapshot',
  source: TMX,
  description: 'Quote and key figures for a TSX or TSX Venture listing: market value, P/E, dividend, 52-week range, sector.',
  params: [{ name: 'symbol', label: 'Symbol', default: 'RY.TO', hint: 'TSX ticker, e.g. RY.TO or SHOP.TO (.V for TSX Venture)' }],
  async run(ctx, params) {
    const raw = (params.symbol || 'RY.TO').trim().toUpperCase();
    const sym = tmxSymbol(raw) ?? tmxSymbol(`${raw}.TO`) ?? raw;
    const data = await tmxQuery<{ getQuoteBySymbol?: TmxQuote | null }>(ctx, 'getQuoteBySymbol', `query getQuoteBySymbol($symbol: String, $locale: String) { getQuoteBySymbol(symbol: $symbol, locale: $locale) { ${QUOTE_FIELDS} } }`, { symbol: sym, locale: 'en' }, 120);
    const q = data.getQuoteBySymbol;
    if (!q || typeof q.price !== 'number') throw new SourceError(TMX, `no Canadian listing "${sym}" (use the TSX ticker, e.g. RY.TO)`);
    const items = ([
      { label: 'Name', value: q.name },
      { label: 'Exchange', value: q.exchangeName },
      { label: 'Sector', value: q.sector },
      { label: 'Industry', value: q.industry },
      { label: 'Last (CAD)', value: q.price, format: 'num' },
      { label: 'Change', value: q.percentChange, format: 'signedPct' },
      { label: 'Previous close', value: q.prevClose, format: 'num' },
      { label: 'Day high', value: q.dayHigh, format: 'num' },
      { label: 'Day low', value: q.dayLow, format: 'num' },
      { label: 'Volume', value: q.volume, format: 'compact' },
      { label: 'Market cap (CAD)', value: q.MarketCap, format: 'compact' },
      { label: 'P/E', value: q.peRatio, format: 'num', digits: 1 },
      { label: 'EPS', value: q.eps, format: 'num' },
      { label: 'Dividend yield', value: q.dividendYield, format: 'pct' },
      { label: 'Dividend', value: q.dividendAmount ? `${q.dividendAmount} ${q.dividendFrequency ?? ''}`.trim() : null },
      { label: 'Ex-dividend date', value: q.exDividendDate?.slice(0, 10) },
      { label: 'Beta', value: q.beta, format: 'num', digits: 2 },
      { label: '52-week high', value: q.weeks52high, format: 'num' },
      { label: '52-week low', value: q.weeks52low, format: 'num' },
    ] as StatItem[]).filter((i) => i.value !== null && i.value !== undefined && i.value !== '');
    return {
      blocks: [{ kind: 'stats', items }, ...(q.shortDescription ? [{ kind: 'text' as const, title: 'About', text: q.shortDescription }] : [])],
      sourceUrl: `https://money.tmx.com/en/quote/${encodeURIComponent(sym)}`,
      notes: ['TMX Money quotes are delayed 15 minutes. Amounts in Canadian dollars.'],
    };
  },
};

// ---------------------------------------------------------------- Nordics

const NORDIC = 'Nasdaq Nordic';

interface NordicRow {
  fullName?: string;
  symbol?: string;
  currency?: string;
  lastSalePrice?: string;
  netChange?: string;
  percentageChange?: string;
  high?: string;
  low?: string;
  volume?: string;
  turnover?: string;
  sector?: string;
  lastTraded?: string;
  orderbookId?: string;
}
interface NordicListing {
  data?: { instrumentListing?: { rows?: NordicRow[] | null } | null } | null;
  status?: { bCodeMessage?: { errorMessage?: string }[] | null };
}

async function nordicList(ctx: Ctx, path: string, ttl: number): Promise<NordicRow[]> {
  const body = await ctx.http.json<NordicListing>(`https://api.nasdaq.com/api/nordic/screener/${path}`, { source: NORDIC, ttl });
  const rows = body.data?.instrumentListing?.rows ?? [];
  if (!rows.length) throw new SourceError(NORDIC, body.status?.bCodeMessage?.[0]?.errorMessage ?? 'no rows');
  return rows;
}

const HEADLINE = ['OMXN40', 'NOMXN120', 'OMXNORDICEURPI', 'OMXNLCEURPI', 'OMXNMCEURPI', 'OMXNSCEURPI'];
const HEADLINE_NAMES: Record<string, string> = {
  OMXN40: 'OMX Nordic 40',
  NOMXN120: 'Nasdaq OMX Nordic 120',
  OMXNORDICEURPI: 'OMX Nordic All-Share (EUR)',
  OMXNLCEURPI: 'OMX Nordic Large Cap (EUR)',
  OMXNMCEURPI: 'OMX Nordic Mid Cap (EUR)',
  OMXNSCEURPI: 'OMX Nordic Small Cap (EUR)',
};
const NATIONAL = [
  { symbol: '^OMXS30', label: 'OMX Stockholm 30' },
  { symbol: '^OMXH25', label: 'OMX Helsinki 25' },
];

const nordicIndices: CardDef = {
  id: 'equities.nordic-indices',
  title: 'Nordic indices',
  source: NORDIC,
  description: 'Pan-Nordic benchmarks, size indices and Nordic sector indices with the day change, plus the Stockholm and Helsinki blue-chip indices.',
  async run(ctx) {
    const [rows, national] = await Promise.all([nordicList(ctx, 'indexes?tableonly=true', 300), getQuotes(ctx, NATIONAL.map((n) => n.symbol))]);
    const toRow = (r: NordicRow, name?: string): Row => ({
      name: name ?? (r.fullName ?? '').replace(/^N /, '').replace(/ EUR PI$/, ''),
      symbol: r.symbol,
      last: num(r.lastSalePrice),
      changePct: num(r.percentageChange),
      high: num(r.high),
      low: num(r.low),
      time: r.lastTraded,
    });
    const head: Row[] = HEADLINE.flatMap((s) => {
      const r = rows.find((x) => x.symbol === s);
      return r ? [toRow(r, HEADLINE_NAMES[s])] : [];
    });
    national.forEach((q, i) => {
      if (q.price !== null) head.push({ name: NATIONAL[i].label, symbol: q.symbol.slice(1), last: q.price, changePct: q.changePct, time: q.time });
    });
    const sectors = rows.filter((r) => /^N .* EUR PI$/.test(r.fullName ?? '') && /^N\d{2}EURPI$/.test(r.symbol ?? '')).map((r) => toRow(r)).sort((a, b) => ((b.changePct as number | null) ?? -99) - ((a.changePct as number | null) ?? -99));
    if (!head.length && !sectors.length) throw new SourceError(NORDIC, 'no index rows matched');
    const columns = [
      { key: 'name', label: 'Index', maxWidth: 40 },
      { key: 'symbol', label: 'Code' },
      { key: 'last', label: 'Last', format: 'num' as const },
      { key: 'changePct', label: 'Day', format: 'signedPct' as const },
      { key: 'high', label: 'High', format: 'num' as const },
      { key: 'low', label: 'Low', format: 'num' as const },
      { key: 'time', label: 'Last update (CET)' },
    ];
    return {
      blocks: [
        { kind: 'table', title: 'Benchmarks', columns, rows: head },
        { kind: 'table', title: 'Nordic sectors (price indices, EUR)', columns, rows: sectors },
      ],
      sourceUrl: 'https://www.nasdaq.com/european-market-activity/indexes',
      notes: ['Price indices (dividends not reinvested) from Nasdaq Nordic, delayed 15 minutes. Stockholm 30 and Helsinki 25 are previous-close values from the Nasdaq index feed.'],
    };
  },
};

const MARKETS: Record<string, string> = { STO: 'Stockholm', CPH: 'Copenhagen', HEL: 'Helsinki', ICE: 'Iceland' };

const nordicShares: CardDef = {
  id: 'equities.nordic-shares',
  title: 'Nordic listings by turnover',
  source: NORDIC,
  description: 'Main-market shares on a Nasdaq Nordic exchange ranked by the day\'s turnover: last, change, volume and sector.',
  params: [{ name: 'market', label: 'Exchange', default: 'STO', choices: Object.keys(MARKETS), hint: 'STO Stockholm, CPH Copenhagen, HEL Helsinki, ICE Iceland' }],
  async run(ctx, params) {
    const market = (params.market ?? 'STO').toUpperCase() in MARKETS ? (params.market ?? 'STO').toUpperCase() : 'STO';
    const list = await nordicList(ctx, `shares?category=MAIN_MARKET&tableonly=true&market=${market}`, 300);
    const rows: Row[] = list
      .map((r) => {
        const last = num(r.lastSalePrice);
        const chg = num(r.netChange);
        return {
          name: r.fullName,
          symbol: r.symbol,
          ccy: r.currency,
          last,
          changePct: num(r.percentageChange) ?? (last !== null && chg !== null ? pctChange(last, last - chg) : null),
          volume: num(r.volume),
          turnover: num(r.turnover),
          sector: r.sector,
        };
      })
      .filter((r) => r.last !== null)
      .sort((a, b) => ((b.turnover as number | null) ?? 0) - ((a.turnover as number | null) ?? 0));
    if (!rows.length) throw new SourceError(NORDIC, `no priced shares for ${market}`);
    const up = rows.filter((r) => ((r.changePct as number | null) ?? 0) > 0).length;
    const down = rows.filter((r) => ((r.changePct as number | null) ?? 0) < 0).length;
    return {
      blocks: [
        { kind: 'stats', items: [{ label: 'Exchange', value: `Nasdaq ${MARKETS[market]}` }, { label: 'Listings priced', value: rows.length, format: 'int' }, { label: 'Advancing', value: up, format: 'int' }, { label: 'Declining', value: down, format: 'int' }] },
        {
          kind: 'table',
          title: 'Top 40 by turnover',
          columns: [
            { key: 'name', label: 'Name', maxWidth: 34 },
            { key: 'symbol', label: 'Symbol' },
            { key: 'ccy', label: 'CCY' },
            { key: 'last', label: 'Last', format: 'num' },
            { key: 'changePct', label: 'Day', format: 'signedPct' },
            { key: 'volume', label: 'Volume', format: 'compact' },
            { key: 'turnover', label: 'Turnover', format: 'compact' },
            { key: 'sector', label: 'Sector', maxWidth: 24 },
          ],
          rows: rows.slice(0, 40),
        },
      ],
      sourceUrl: 'https://www.nasdaq.com/european-market-activity/shares',
      notes: ['Nasdaq Nordic main market, delayed 15 minutes. Turnover is in the listing currency.'],
    };
  },
};

export const canadaCards: CardDef[] = [canadaIndices, canadaBoard, canadaQuote];
export const nordicCards: CardDef[] = [nordicIndices, nordicShares];
