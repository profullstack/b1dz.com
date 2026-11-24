/** Screeners & Movers, and Calendars & Events (all from the Nasdaq public API). */
import { num } from '../../http.js';
import { NASDAQ, nasdaqGet, parseNasdaqTime } from '../../lib/nasdaq.js';
import { SourceError, type CardDef, type Column, type Ctx, type ParamSpec, type Row } from '../../types.js';
import { longDate, usDate } from './util.js';

// ---------------------------------------------------------------- movers

interface MoverTable {
  dataAsOf?: string;
  table?: { rows?: { symbol?: string; name?: string; lastSalePrice?: string; lastSaleChange?: string; change?: string }[] | null } | null;
}
type Movers = Record<string, Record<string, MoverTable | undefined> | undefined>;

function moversCard(id: string, title: string, key: string, description: string, third: Column): CardDef {
  return {
    id,
    title,
    source: NASDAQ,
    description,
    async run(ctx) {
      const data = await nasdaqGet<Movers>(ctx, '/api/marketmovers?assetclass=stocks&limit=30', 120);
      const t = data.STOCKS?.[key];
      const rows: Row[] = (t?.table?.rows ?? []).map((r) => {
        const last = num(r.lastSalePrice);
        const chg = num(r.lastSaleChange);
        const third3 = num(r.change);
        return {
          symbol: r.symbol,
          name: (r.name ?? '').replace(/ (Common Stock|Ordinary Shares|Class [A-Z] Common Stock)$/i, ''),
          last,
          change: chg,
          // The feed gives a percent only on the gainers and losers lists; derive it for the volume list.
          changePct: third.key === 'volume' ? (last !== null && chg !== null && last - chg !== 0 ? (chg / (last - chg)) * 100 : null) : third3,
          volume: third.key === 'volume' ? third3 : null,
        };
      });
      if (!rows.length) throw new SourceError(NASDAQ, `no ${title.toLowerCase()} list right now`);
      const columns: Column[] = [
        { key: 'symbol', label: 'Symbol' },
        { key: 'name', label: 'Name', maxWidth: 44 },
        { key: 'last', label: 'Last', format: 'usd' },
        { key: 'change', label: 'Change', format: 'signed' },
        { key: 'changePct', label: '% change', format: 'signedPct' },
        ...(third.key === 'volume' ? [third] : []),
      ];
      return {
        blocks: [{ kind: 'table', columns, rows }],
        sourceUrl: 'https://www.nasdaq.com/market-activity/stocks',
        asOf: parseNasdaqTime(t?.dataAsOf),
        notes: [t?.dataAsOf ?? '', 'U.S.-listed stocks on all exchanges. The gainers and losers lists include very low-priced shares.'].filter(Boolean),
      };
    },
  };
}

const VOLUME: Column = { key: 'volume', label: 'Share volume', format: 'int' };
const mostActive = moversCard('equities.most-active', 'Most active stocks', 'MostActiveByShareVolume', 'U.S. stocks with the highest share volume in the latest session.', VOLUME);
const gainers = moversCard('equities.gainers', 'Top gainers', 'MostAdvanced', 'U.S. stocks with the largest percentage gains in the latest session.', { key: 'changePct', label: '% change' });
const losers = moversCard('equities.losers', 'Top losers', 'MostDeclined', 'U.S. stocks with the largest percentage losses in the latest session.', { key: 'changePct', label: '% change' });

// ---------------------------------------------------------------- screener

const SECTORS = ['all', 'technology', 'telecommunications', 'health_care', 'finance', 'real_estate', 'consumer_discretionary', 'consumer_staples', 'industrials', 'basic_materials', 'energy', 'utilities'];
const CAPS = ['all', 'mega', 'large', 'mid', 'small', 'micro', 'nano'];
const EXCHANGES = ['all', 'nasdaq', 'nyse', 'amex'];

const screener: CardDef = {
  id: 'equities.screener',
  title: 'Stock screener',
  source: NASDAQ,
  description: 'U.S.-listed stocks filtered by exchange, sector and market-cap bucket, largest first.',
  params: [
    { name: 'exchange', label: 'Exchange', default: 'all', choices: EXCHANGES },
    { name: 'sector', label: 'Sector', default: 'technology', choices: SECTORS },
    { name: 'marketcap', label: 'Market cap', default: 'large', choices: CAPS, hint: 'mega >$200B, large $10-200B, mid $2-10B, small $300M-2B, micro $50-300M, nano <$50M' },
  ],
  async run(ctx, params) {
    const pick = (v: string | undefined, allowed: string[]): string => (v && allowed.includes(v.toLowerCase()) ? v.toLowerCase() : 'all');
    const exchange = pick(params.exchange, EXCHANGES);
    const sector = pick(params.sector, SECTORS);
    const cap = pick(params.marketcap, CAPS);
    const qs = ['tableonly=true', 'limit=50', 'offset=0', exchange !== 'all' ? `exchange=${exchange}` : '', sector !== 'all' ? `sector=${sector}` : '', cap !== 'all' ? `marketcap=${cap}` : ''].filter(Boolean).join('&');
    const data = await nasdaqGet<{ table?: { rows?: Record<string, string>[] | null } | null; totalrecords?: number; asof?: string }>(ctx, `/api/screener/stocks?${qs}`, 900);
    const rows: Row[] = (data.table?.rows ?? []).map((r) => ({
      symbol: r.symbol,
      name: (r.name ?? '').replace(/ (Common Stock|Ordinary Shares|Common Shares)$/i, ''),
      last: num(r.lastsale),
      change: num(r.netchange),
      changePct: num(r.pctchange),
      marketCap: num(r.marketCap) || null,
    }));
    if (!rows.length) throw new SourceError(NASDAQ, 'no stocks match these filters');
    rows.sort((a, b) => ((b.marketCap as number | null) ?? 0) - ((a.marketCap as number | null) ?? 0));
    return {
      blocks: [
        {
          kind: 'table',
          title: `${data.totalrecords ?? rows.length} matches (showing ${rows.length})`,
          columns: [
            { key: 'symbol', label: 'Symbol' },
            { key: 'name', label: 'Name', maxWidth: 46 },
            { key: 'last', label: 'Last', format: 'usd' },
            { key: 'change', label: 'Change', format: 'signed', digits: 2 },
            { key: 'changePct', label: '% change', format: 'signedPct' },
            { key: 'marketCap', label: 'Market cap', format: 'usdCompact' },
          ],
          rows,
        },
      ],
      sourceUrl: 'https://www.nasdaq.com/market-activity/stocks/screener',
      asOf: longDate((data.asof ?? '').replace(/^.*as of /i, '')),
      notes: [data.asof ?? '', 'Sectors are Nasdaq classifications. Open a row in Company with its symbol.'].filter(Boolean),
    };
  },
};

// ---------------------------------------------------------------- calendars

const DATE: ParamSpec = { name: 'date', label: 'Date', default: 'today', hint: 'YYYY-MM-DD, or today' };

/** 'today' (or anything that is not a date) -> the current date in New York. */
export function calendarDate(value: string | undefined, now: Date): string {
  if (value && /^\d{4}-\d{2}-\d{2}$/.test(value.trim())) return value.trim();
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

const TIME: Record<string, string> = { 'time-pre-market': 'Before open', 'time-after-hours': 'After close', 'time-not-supplied': '' };

const earningsCalendar: CardDef = {
  id: 'equities.earnings-calendar',
  title: 'Earnings calendar',
  source: NASDAQ,
  description: 'Companies reporting on a date: timing, consensus EPS, number of estimates and the year-ago figure.',
  params: [DATE],
  async run(ctx, params) {
    const date = calendarDate(params.date, ctx.now());
    const data = await nasdaqGet<{ rows?: Record<string, string>[] | null }>(ctx, `/api/calendar/earnings?date=${date}`, 1800);
    const rows: Row[] = (data.rows ?? []).map((r) => ({
      symbol: r.symbol,
      name: r.name,
      when: TIME[r.time] ?? '',
      marketCap: num(r.marketCap) || null,
      quarter: r.fiscalQuarterEnding,
      eps: num(r.epsForecast),
      n: num(r.noOfEsts),
      lastEps: num(r.lastYearEPS),
      lastDate: usDate(r.lastYearRptDt),
    }));
    if (!rows.length) throw new SourceError(NASDAQ, `no earnings reports scheduled for ${date} (weekend or holiday?)`);
    rows.sort((a, b) => ((b.marketCap as number | null) ?? 0) - ((a.marketCap as number | null) ?? 0));
    return {
      blocks: [
        {
          kind: 'table',
          title: `${rows.length} reports on ${date}`,
          columns: [
            { key: 'symbol', label: 'Symbol' },
            { key: 'name', label: 'Company', maxWidth: 38 },
            { key: 'when', label: 'Timing' },
            { key: 'marketCap', label: 'Market cap', format: 'usdCompact' },
            { key: 'quarter', label: 'Quarter' },
            { key: 'eps', label: 'Consensus EPS', format: 'usd', digits: 2 },
            { key: 'n', label: 'Ests', format: 'int' },
            { key: 'lastEps', label: 'Year-ago EPS', format: 'usd', digits: 2 },
            { key: 'lastDate', label: 'Year-ago date' },
          ],
          rows: rows.slice(0, 60),
        },
      ],
      sourceUrl: `https://www.nasdaq.com/market-activity/earnings?date=${date}`,
      asOf: date,
      notes: ['Largest companies first. Dates are expected dates until the company confirms; estimates are from Zacks via Nasdaq.'],
    };
  },
};

const dividendCalendar: CardDef = {
  id: 'equities.dividend-calendar',
  title: 'Dividend calendar',
  source: NASDAQ,
  description: 'Securities going ex-dividend on a date, with the amount, annual rate and the record and payment dates.',
  params: [DATE],
  async run(ctx, params) {
    const date = calendarDate(params.date, ctx.now());
    const data = await nasdaqGet<{ calendar?: { rows?: Record<string, string | number>[] | null } | null }>(ctx, `/api/calendar/dividends?date=${date}`, 1800);
    const rows: Row[] = (data.calendar?.rows ?? []).map((r) => ({
      symbol: String(r.symbol ?? ''),
      name: String(r.companyName ?? ''),
      amount: num(r.dividend_Rate),
      annual: num(r.indicated_Annual_Dividend),
      exDate: usDate(String(r.dividend_Ex_Date ?? '')),
      record: usDate(String(r.record_Date ?? '')),
      paid: usDate(String(r.payment_Date ?? '')),
      announced: usDate(String(r.announcement_Date ?? '')),
    }));
    if (!rows.length) throw new SourceError(NASDAQ, `nothing goes ex-dividend on ${date} (weekend or holiday?)`);
    rows.sort((a, b) => ((b.amount as number | null) ?? 0) - ((a.amount as number | null) ?? 0));
    return {
      blocks: [
        {
          kind: 'table',
          title: `${rows.length} ex-dividend on ${date}`,
          columns: [
            { key: 'symbol', label: 'Symbol' },
            { key: 'name', label: 'Name', maxWidth: 44 },
            { key: 'amount', label: 'Dividend', format: 'usd', digits: 4 },
            { key: 'annual', label: 'Annual rate', format: 'usd', digits: 4 },
            { key: 'record', label: 'Record' },
            { key: 'paid', label: 'Payment' },
            { key: 'announced', label: 'Announced' },
          ],
          rows: rows.slice(0, 60),
        },
      ],
      sourceUrl: `https://www.nasdaq.com/market-activity/dividends?date=${date}`,
      asOf: date,
      notes: ['Largest payment per share first. Includes funds and ETFs.'],
    };
  },
};

interface Ipo {
  priced?: { rows?: Record<string, string | null>[] | null } | null;
  upcoming?: { upcomingTable?: { rows?: Record<string, string | null>[] | null } | null } | null;
  filed?: { rows?: Record<string, string | null>[] | null } | null;
  withdrawn?: { rows?: Record<string, string | null>[] | null } | null;
}

const ipoCalendar: CardDef = {
  id: 'equities.ipo-calendar',
  title: 'IPO calendar',
  source: NASDAQ,
  description: 'U.S. initial public offerings in a month: upcoming, priced, newly filed and withdrawn deals.',
  params: [{ name: 'month', label: 'Month', default: 'this', hint: 'YYYY-MM, or this' }],
  async run(ctx, params) {
    const month = /^\d{4}-\d{2}$/.test(params.month ?? '') ? params.month : calendarDate(undefined, ctx.now()).slice(0, 7);
    const d = await nasdaqGet<Ipo>(ctx, `/api/ipo/calendar?date=${month}`, 3600);
    const map = (rows: Record<string, string | null>[] | null | undefined, status: string, dateKey: string): Row[] =>
      (rows ?? []).map((r) => ({
        status,
        date: usDate(r[dateKey] ?? r.expectedPriceDate ?? ''),
        symbol: r.proposedTickerSymbol ?? '',
        name: r.companyName ?? '',
        exchange: r.proposedExchange ?? '',
        price: r.proposedSharePrice ?? '',
        shares: num(r.sharesOffered),
        amount: num(r.dollarValueOfSharesOffered),
      }));
    const rows = [
      ...map(d.upcoming?.upcomingTable?.rows, 'Upcoming', 'expectedPriceDate'),
      ...map(d.priced?.rows, 'Priced', 'pricedDate'),
      ...map(d.filed?.rows, 'Filed', 'filedDate'),
      ...map(d.withdrawn?.rows, 'Withdrawn', 'withdrawDate'),
    ];
    if (!rows.length) throw new SourceError(NASDAQ, `no IPO activity listed for ${month}`);
    return {
      blocks: [
        {
          kind: 'table',
          title: `IPO activity, ${month}`,
          columns: [
            { key: 'status', label: 'Status' },
            { key: 'date', label: 'Date' },
            { key: 'symbol', label: 'Symbol' },
            { key: 'name', label: 'Company', maxWidth: 44 },
            { key: 'exchange', label: 'Exchange', maxWidth: 22 },
            { key: 'price', label: 'Price' },
            { key: 'shares', label: 'Shares', format: 'compact' },
            { key: 'amount', label: 'Offer amount', format: 'usdCompact' },
          ],
          rows,
        },
      ],
      sourceUrl: 'https://www.nasdaq.com/market-activity/ipos',
      asOf: month,
      notes: ['Deal data from EDGAR filings as compiled by Nasdaq. Price is a single price once priced, otherwise the proposed range.'],
    };
  },
};

const splitsCalendar: CardDef = {
  id: 'equities.splits-calendar',
  title: 'Stock splits',
  source: NASDAQ,
  description: 'Announced stock splits and reverse splits with their ratios and effective dates.',
  async run(ctx) {
    const date = calendarDate(undefined, ctx.now());
    const data = await nasdaqGet<{ rows?: Record<string, string>[] | null }>(ctx, `/api/calendar/splits?date=${date}`, 3600);
    const rows: Row[] = (data.rows ?? []).map((r) => {
      const [a, b] = (r.ratio ?? '').split(':').map((x) => num(x));
      return {
        date: usDate(r.executionDate),
        symbol: r.symbol,
        name: r.name,
        ratio: (r.ratio ?? '').replace(/\s+/g, ''),
        kind: a != null && b != null ? (a > b ? 'Split' : a < b ? 'Reverse split' : '') : '',
      };
    });
    if (!rows.length) throw new SourceError(NASDAQ, 'no splits listed');
    rows.sort((a, b) => String(a.date).localeCompare(String(b.date)));
    return {
      blocks: [
        {
          kind: 'table',
          columns: [
            { key: 'date', label: 'Effective' },
            { key: 'symbol', label: 'Symbol' },
            { key: 'name', label: 'Name', maxWidth: 60 },
            { key: 'ratio', label: 'Ratio (new:old)' },
            { key: 'kind', label: 'Type' },
          ],
          rows,
        },
      ],
      sourceUrl: 'https://www.nasdaq.com/market-activity/stock-splits',
      asOf: date,
      notes: ['Ratio is new shares for old: 2:1 doubles the share count, 1:10 is a reverse split.'],
    };
  },
};

/** Economic calendar rows for one date; shared with the country filter. */
async function economicRows(ctx: Ctx, date: string): Promise<Row[]> {
  const data = await nasdaqGet<{ rows?: Record<string, string>[] | null }>(ctx, `/api/calendar/economicevents?date=${date}`, 900);
  return (data.rows ?? []).map((r) => ({
    time: r.gmt === '24H' ? 'All day' : r.gmt,
    country: r.country,
    event: r.eventName,
    actual: r.actual?.replace(/&nbsp;/g, '').trim(),
    consensus: r.consensus?.replace(/&nbsp;/g, '').trim(),
    previous: r.previous?.replace(/&nbsp;/g, '').trim(),
  }));
}

const economicCalendar: CardDef = {
  id: 'equities.economic-calendar',
  title: 'Economic events',
  source: NASDAQ,
  description: 'Scheduled economic releases for a date across countries: actual, consensus and previous values.',
  params: [DATE, { name: 'country', label: 'Country', default: 'all', hint: 'all, or a country name such as United States, Japan, Germany' }],
  async run(ctx, params) {
    const date = calendarDate(params.date, ctx.now());
    const all = await economicRows(ctx, date);
    const want = (params.country ?? 'all').trim().toLowerCase();
    const ALIAS: Record<string, string> = { us: 'united states', usa: 'united states', uk: 'united kingdom', gb: 'united kingdom', jp: 'japan', de: 'germany', fr: 'france', cn: 'china', ca: 'canada', eu: 'euro zone', au: 'australia' };
    const name = ALIAS[want] ?? want;
    const rows = name === 'all' || name === '' ? all : all.filter((r) => String(r.country ?? '').toLowerCase() === name);
    if (!rows.length) throw new SourceError(NASDAQ, all.length ? `no events for "${params.country}" on ${date}; countries listed: ${[...new Set(all.map((r) => r.country))].join(', ')}` : `no economic events listed for ${date}`);
    return {
      blocks: [
        {
          kind: 'table',
          title: `${rows.length} events on ${date}`,
          columns: [
            { key: 'time', label: 'Time (ET)' },
            { key: 'country', label: 'Country', maxWidth: 16 },
            { key: 'event', label: 'Event', maxWidth: 54 },
            { key: 'actual', label: 'Actual', align: 'right' },
            { key: 'consensus', label: 'Consensus', align: 'right' },
            { key: 'previous', label: 'Previous', align: 'right' },
          ],
          rows: rows.slice(0, 80),
        },
      ],
      sourceUrl: 'https://www.nasdaq.com/market-activity/economic-calendar',
      asOf: date,
      notes: ['Times are U.S. Eastern. Values are shown as published, in each release\'s own unit; "Actual" is blank until the release.'],
    };
  },
};

export const screenerCards: CardDef[] = [mostActive, gainers, losers, screener];
export const calendarCards: CardDef[] = [earningsCalendar, dividendCalendar, ipoCalendar, economicCalendar, splitsCalendar];
