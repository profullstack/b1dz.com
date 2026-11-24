/** Indices: world boards, U.S. sectors, Nasdaq-100 constituents, the S&P 500 over the long run. */
import { num } from '../../http.js';
import { getHistory, returnsBoard, type Bar } from '../../lib/market.js';
import { NASDAQ, nasdaqGet } from '../../lib/nasdaq.js';
import { SourceError, type CardDef, type Row } from '../../types.js';
import { longDate, maxDrawdown } from './util.js';
import { monthEnds } from './xbrl.js';

const WORLD = [
  { symbol: '^GSPC', label: 'S&P 500' },
  { symbol: '^DJI', label: 'Dow Jones Industrial Average' },
  { symbol: '^IXIC', label: 'Nasdaq Composite' },
  { symbol: '^NDX', label: 'Nasdaq-100' },
  { symbol: '^RUT', label: 'Russell 2000' },
  { symbol: '^VIX', label: 'Cboe VIX (volatility)' },
  { symbol: '^GSPTSE', label: 'S&P/TSX Composite (Canada)' },
  { symbol: '^MXEA', label: 'MSCI EAFE (developed ex North America)' },
  { symbol: '^MXEF', label: 'MSCI Emerging Markets' },
  { symbol: '^FTSE', label: 'FTSE 100 (UK)' },
  { symbol: '^GDAXI', label: 'DAX (Germany)' },
  { symbol: '^FCHI', label: 'CAC 40 (France)' },
  { symbol: '^STOXX50E', label: 'Euro Stoxx 50' },
  { symbol: '^N225', label: 'Nikkei 225 (Japan)' },
  { symbol: '^HSI', label: 'Hang Seng (Hong Kong)' },
  { symbol: '^AXJO', label: 'S&P/ASX 200 (Australia)' },
  { symbol: '^BSESN', label: 'BSE Sensex (India)' },
  { symbol: '^BVSP', label: 'Bovespa (Brazil)' },
];

const worldIndices: CardDef = {
  id: 'equities.world-indices',
  title: 'World indices',
  source: 'Cboe',
  description: 'Major equity indices: last close, day change and returns over one week, one month, three months, year to date and one year.',
  async run(ctx) {
    const b = await returnsBoard(ctx, WORLD);
    return {
      blocks: [b.block],
      source: b.source,
      notes: [...b.notes, 'U.S., Canadian and MSCI indices come from exchange files (Cboe, Nasdaq, TMX). National indices outside North America come from Yahoo Finance and are blank where Yahoo refuses the connection; the Country ETFs board covers the same markets from U.S. listings.'],
    };
  },
};

const COUNTRIES = [
  { symbol: 'SPY', label: 'United States (S&P 500)' },
  { symbol: 'EWC', label: 'Canada' },
  { symbol: 'EWW', label: 'Mexico' },
  { symbol: 'EWZ', label: 'Brazil' },
  { symbol: 'EZU', label: 'Euro area' },
  { symbol: 'EWU', label: 'United Kingdom' },
  { symbol: 'EWG', label: 'Germany' },
  { symbol: 'EWQ', label: 'France' },
  { symbol: 'EWI', label: 'Italy' },
  { symbol: 'EWP', label: 'Spain' },
  { symbol: 'EWL', label: 'Switzerland' },
  { symbol: 'EWD', label: 'Sweden' },
  { symbol: 'EWJ', label: 'Japan' },
  { symbol: 'MCHI', label: 'China' },
  { symbol: 'EWH', label: 'Hong Kong' },
  { symbol: 'EWT', label: 'Taiwan' },
  { symbol: 'EWY', label: 'South Korea' },
  { symbol: 'INDA', label: 'India' },
  { symbol: 'EWA', label: 'Australia' },
  { symbol: 'EZA', label: 'South Africa' },
  { symbol: 'EFA', label: 'Developed ex North America' },
  { symbol: 'EEM', label: 'Emerging markets' },
  { symbol: 'ACWI', label: 'World (all countries)' },
];

const countryEtfs: CardDef = {
  id: 'equities.country-etfs',
  title: 'World markets (country ETFs)',
  source: NASDAQ,
  description: 'U.S.-listed single-country and regional equity ETFs as a world market board, in U.S. dollars.',
  async run(ctx) {
    const b = await returnsBoard(ctx, COUNTRIES);
    return { blocks: [b.block], source: b.source, notes: [...b.notes, 'ETF prices in U.S. dollars, so each return includes the currency move against the dollar and differs from the local index.'] };
  },
};

const SECTORS = [
  { symbol: 'SPY', label: 'S&P 500' },
  { symbol: 'XLK', label: 'Technology' },
  { symbol: 'XLC', label: 'Communication Services' },
  { symbol: 'XLY', label: 'Consumer Discretionary' },
  { symbol: 'XLP', label: 'Consumer Staples' },
  { symbol: 'XLF', label: 'Financials' },
  { symbol: 'XLV', label: 'Health Care' },
  { symbol: 'XLI', label: 'Industrials' },
  { symbol: 'XLE', label: 'Energy' },
  { symbol: 'XLB', label: 'Materials' },
  { symbol: 'XLRE', label: 'Real Estate' },
  { symbol: 'XLU', label: 'Utilities' },
];

const usSectors: CardDef = {
  id: 'equities.us-sectors',
  title: 'U.S. sectors',
  source: NASDAQ,
  description: 'The eleven S&P 500 sectors through their Select Sector SPDR ETFs, against the index.',
  async run(ctx) {
    const b = await returnsBoard(ctx, SECTORS);
    return { blocks: [b.block], source: b.source, notes: b.notes };
  },
};

interface Ndx {
  date?: string;
  data?: { rows?: { symbol?: string; companyName?: string; marketCap?: string; lastSalePrice?: string; netChange?: string; percentageChange?: string; deltaIndicator?: string }[] | null } | null;
}

const constituents: CardDef = {
  id: 'equities.index-constituents',
  title: 'Nasdaq-100 constituents',
  source: NASDAQ,
  description: 'Every Nasdaq-100 member with its market value, share of the total, last price and day change.',
  async run(ctx) {
    const d = await nasdaqGet<Ndx>(ctx, '/api/quote/list-type/nasdaq100', 900);
    const list = (d.data?.rows ?? []).map((r) => {
      const pct = num(r.percentageChange);
      return {
        symbol: r.symbol,
        name: (r.companyName ?? '').replace(/ (Common Stock|Ordinary Shares|Class [A-Z] Common Stock|American Depositary Shares?)$/i, ''),
        marketCap: num(r.marketCap) || null,
        last: num(r.lastSalePrice),
        // The feed sends an unsigned change with a separate direction flag.
        changePct: pct === null ? null : r.deltaIndicator === 'down' ? -Math.abs(pct) : pct,
      };
    });
    if (!list.length) throw new SourceError(NASDAQ, 'no Nasdaq-100 constituent list');
    const total = list.reduce((a, r) => a + (r.marketCap ?? 0), 0);
    const rows: Row[] = list.sort((a, b) => (b.marketCap ?? 0) - (a.marketCap ?? 0)).map((r, i) => ({ rank: i + 1, ...r, share: r.marketCap && total ? (r.marketCap / total) * 100 : null }));
    return {
      blocks: [
        {
          kind: 'table',
          title: `${rows.length} listings, combined market value $${(total / 1e12).toFixed(1)}T`,
          columns: [
            { key: 'rank', label: '#', format: 'int' },
            { key: 'symbol', label: 'Symbol' },
            { key: 'name', label: 'Name', maxWidth: 40 },
            { key: 'marketCap', label: 'Market cap', format: 'usdCompact' },
            { key: 'share', label: 'Share', format: 'pct' },
            { key: 'last', label: 'Last', format: 'usd' },
            { key: 'changePct', label: 'Day', format: 'signedPct' },
          ],
          rows,
        },
      ],
      sourceUrl: 'https://www.nasdaq.com/market-activity/quotes/nasdaq-ndx-index',
      asOf: longDate(d.date),
      notes: ['"Share" is each company\'s share of the combined market value, an approximation: official index weights are modified market-cap weights with caps on the largest members. Companies with two share classes appear twice.'],
    };
  },
};

/** Compound annual growth rate in percent between two bars. */
export function cagr(first: Bar, last: Bar): number | null {
  const years = (last.t - first.t) / (365.25 * 86_400_000);
  if (years <= 0 || first.c <= 0) return null;
  return ((last.c / first.c) ** (1 / years) - 1) * 100;
}

/** Percent below the highest close so far (0 at a record). */
export function drawdownSeries(bars: Bar[]): [number, number][] {
  let peak = -Infinity;
  return bars.map((b) => {
    if (b.c > peak) peak = b.c;
    return [b.t, (b.c / peak - 1) * 100];
  });
}

const spLongRun: CardDef = {
  id: 'equities.sp500-long-run',
  title: 'S&P 500 over the long run',
  source: 'Cboe',
  description: 'Daily closes since 1975: level, drawdown from the record high, compound growth and the deepest falls.',
  async run(ctx) {
    const h = await getHistory(ctx, '^GSPC', 'MAX');
    const bars = h.bars;
    const first = bars[0];
    const last = bars[bars.length - 1];
    const dd = drawdownSeries(bars);
    const ath = bars.reduce((a, b) => (b.c >= a.c ? b : a));
    const worst = dd.reduce((a, b) => (b[1] < a[1] ? b : a));
    const monthly = monthEnds(bars);
    const ddMonthly = monthEnds(dd.map(([t, v]) => ({ t, v })));
    const back = (years: number): Bar | undefined => bars.find((b) => b.t >= last.t - years * 365.25 * 86_400_000);
    const row = (label: string, from: Bar | undefined): Row => ({ period: label, from: from ? new Date(from.t).toISOString().slice(0, 10) : '', cagr: from ? cagr(from, last) : null, total: from ? (last.c / from.c - 1) * 100 : null });
    return {
      blocks: [
        { kind: 'stats', items: [
          { label: 'Last close', value: last.c, format: 'num' },
          { label: 'Record close', value: ath.c, format: 'num' },
          { label: 'Record date', value: ath.t, format: 'date' },
          { label: 'Below record', value: dd[dd.length - 1][1], format: 'signedPct' },
          { label: 'Deepest drawdown', value: maxDrawdown(bars), format: 'signedPct' },
          { label: 'Trough date', value: worst[0], format: 'date' },
        ] },
        { kind: 'chart', title: 'S&P 500 (month end)', xType: 'time', series: [{ name: 'S&P 500', points: monthly.map((b) => [b.t, b.c]) }], yFormat: 'num', yDigits: 0 },
        { kind: 'chart', title: 'Drawdown from record high', xType: 'time', series: [{ name: 'Drawdown %', points: ddMonthly.map((b) => [b.t, b.v]) }], yFormat: 'pct', yDigits: 0 },
        {
          kind: 'table',
          title: 'Compound annual price return',
          columns: [
            { key: 'period', label: 'Window' },
            { key: 'from', label: 'From' },
            { key: 'cagr', label: 'Per year', format: 'signedPct' },
            { key: 'total', label: 'Total', format: 'signedPct', digits: 0 },
          ],
          rows: [row('1 year', back(1)), row('5 years', back(5)), row('10 years', back(10)), row('20 years', back(20)), row('30 years', back(30)), row(`Since ${new Date(first.t).getUTCFullYear()}`, first)],
        },
      ],
      source: h.source,
      sourceUrl: 'https://www.cboe.com/tradable_products/sp_500/',
      asOf: new Date(last.t).toISOString().slice(0, 10),
      notes: ['Price index: dividends are not included, which understates the total return by roughly the dividend yield each year. Valuation series (earnings yield, CAPE) are not included: no official machine-readable source is open.'],
    };
  },
};

export const indexCards: CardDef[] = [worldIndices, countryEtfs, usSectors, constituents, spLongRun];
