/** Futures & Positioning dashboard: front-month board, VIX / Fed funds / WTI curves, CFTC positioning. */
import { csvObjects, num } from '../../http.js';
import { getQuotes, type Quote } from '../../lib/market.js';
import { SourceError, type CardDef, type Ctx, type Row } from '../../types.js';
import { COT_URL, cotNetChange, cotNetSeries, getCot, isCotCode, type CotData } from './cot.js';

const DAY = 86_400_000;
const iso = (d: Date): string => d.toISOString().slice(0, 10);

// ---------------------------------------------------------------- VIX futures (Cboe settlement file)

export interface VxSettle {
  symbol: string;
  expiry: string;
  price: number;
  weekly: boolean;
}

/**
 * Cboe Futures Exchange daily settlement CSV (Product,Symbol,Expiration Date,Price)
 * to VIX futures rows, sorted by expiry. Monthly contracts are `VX/Z6`;
 * weeklies carry a week number (`VX48/Z6`).
 */
export function parseVxSettlements(csv: string): VxSettle[] {
  const out: VxSettle[] = [];
  for (const r of csvObjects(csv)) {
    if (r.Product !== 'VX') continue;
    const price = num(r.Price);
    const expiry = r['Expiration Date'];
    if (price === null || !/^\d{4}-\d{2}-\d{2}$/.test(expiry ?? '')) continue;
    out.push({ symbol: r.Symbol, expiry, price, weekly: /^VX\d+\//.test(r.Symbol) });
  }
  return out.sort((a, b) => (a.expiry < b.expiry ? -1 : a.expiry > b.expiry ? 1 : 0));
}

const CBOE_SETTLE = 'https://www.cboe.com/us/futures/market_statistics/settlement/';

/** The newest settlement file at or before `from`, looking back over weekends and holidays. */
async function vxSettlement(ctx: Ctx, from: Date): Promise<{ date: string; rows: VxSettle[] }> {
  let d = from;
  for (let i = 0; i < 8; i++, d = new Date(d.getTime() - DAY)) {
    const dow = d.getUTCDay();
    if (dow === 0 || dow === 6) continue;
    const csv = await ctx.http.text(`${CBOE_SETTLE}csv?dt=${iso(d)}`, { source: 'Cboe', ttl: 3600 });
    const rows = parseVxSettlements(csv);
    if (rows.length) return { date: iso(d), rows };
  }
  throw new SourceError('Cboe', `no VIX futures settlement file in the week to ${iso(from)}`);
}

const vixCard: CardDef = {
  id: 'derivatives.vix-futures',
  title: 'VIX Futures Term Structure',
  source: 'Cboe',
  description: 'Daily settlement prices of monthly VIX futures by expiry, with the change from the previous settlement.',
  async run(ctx) {
    const now = ctx.now();
    const latest = await vxSettlement(ctx, now);
    const prior = await vxSettlement(ctx, new Date(Date.parse(`${latest.date}T00:00:00Z`) - DAY));
    const before = new Map(prior.rows.map((r) => [r.symbol, r.price]));
    const monthly = latest.rows.filter((r) => !r.weekly && r.expiry >= latest.date);
    if (!monthly.length) throw new SourceError('Cboe', 'no monthly VIX futures in the settlement file');
    const front = monthly[0];
    const days = (e: string): number => Math.round((Date.parse(`${e}T00:00:00Z`) - Date.parse(`${latest.date}T00:00:00Z`)) / DAY);
    const rows: Row[] = monthly.map((r, i) => ({
      contract: r.symbol,
      expiry: r.expiry,
      days: days(r.expiry),
      settle: r.price,
      chg: before.has(r.symbol) ? r.price - (before.get(r.symbol) as number) : null,
      vsFront: i === 0 ? null : r.price - front.price,
      roll: i === 0 ? null : r.price - monthly[i - 1].price,
    }));
    const second = monthly[1];
    return {
      blocks: [
        {
          kind: 'stats',
          items: [
            { label: `Front month (${front.symbol})`, value: front.price, format: 'num', digits: 2 },
            { label: 'Second month', value: second?.price, format: 'num', digits: 2 },
            { label: 'Second - front', value: second ? second.price - front.price : null, format: 'signed', digits: 2 },
            { label: 'Shape', value: second ? (second.price > front.price ? 'contango (upward)' : 'backwardation (inverted)') : null },
            { label: 'Last - front', value: monthly[monthly.length - 1].price - front.price, format: 'signed', digits: 2 },
          ],
        },
        {
          kind: 'chart',
          title: `VIX futures settlement, ${latest.date} vs ${prior.date}`,
          xType: 'number',
          xLabel: 'Days to expiry',
          yFormat: 'num',
          yDigits: 1,
          series: [
            { name: latest.date, points: monthly.map((r) => [days(r.expiry), r.price]) },
            { name: prior.date, points: prior.rows.filter((r) => !r.weekly && r.expiry >= latest.date).map((r) => [days(r.expiry), r.price]) },
          ],
        },
        {
          kind: 'table',
          columns: [
            { key: 'contract', label: 'Contract' },
            { key: 'expiry', label: 'Expiry' },
            { key: 'days', label: 'Days', format: 'int' },
            { key: 'settle', label: 'Settle', format: 'num', digits: 2 },
            { key: 'chg', label: 'Chg', format: 'signed', digits: 2 },
            { key: 'vsFront', label: 'vs front', format: 'signed', digits: 2 },
            { key: 'roll', label: 'vs prior month', format: 'signed', digits: 2 },
          ],
          rows,
        },
      ],
      sourceUrl: CBOE_SETTLE,
      asOf: latest.date,
      notes: ['Daily settlement prices from Cboe Futures Exchange, monthly contracts only (weeklies omitted). Not intraday.'],
    };
  },
};

// ---------------------------------------------------------------- quote-based boards (shared market data)

interface BoardItem {
  symbol: string;
  label: string;
  group: string;
}

export const FRONT_MONTH: BoardItem[] = [
  { symbol: 'ES=F', label: 'E-mini S&P 500', group: 'Equity index' },
  { symbol: 'NQ=F', label: 'E-mini Nasdaq-100', group: 'Equity index' },
  { symbol: 'YM=F', label: 'E-mini Dow', group: 'Equity index' },
  { symbol: 'RTY=F', label: 'E-mini Russell 2000', group: 'Equity index' },
  { symbol: 'ZT=F', label: '2-Year T-Note', group: 'Treasury' },
  { symbol: 'ZF=F', label: '5-Year T-Note', group: 'Treasury' },
  { symbol: 'ZN=F', label: '10-Year T-Note', group: 'Treasury' },
  { symbol: 'ZB=F', label: 'T-Bond', group: 'Treasury' },
  { symbol: '6E=F', label: 'Euro FX', group: 'Currency' },
  { symbol: '6J=F', label: 'Japanese Yen', group: 'Currency' },
  { symbol: '6B=F', label: 'British Pound', group: 'Currency' },
  { symbol: '6C=F', label: 'Canadian Dollar', group: 'Currency' },
  { symbol: '6A=F', label: 'Australian Dollar', group: 'Currency' },
  { symbol: 'DX=F', label: 'U.S. Dollar Index', group: 'Currency' },
  { symbol: 'CL=F', label: 'WTI Crude', group: 'Commodity' },
  { symbol: 'BZ=F', label: 'Brent Crude', group: 'Commodity' },
  { symbol: 'NG=F', label: 'Natural Gas', group: 'Commodity' },
  { symbol: 'GC=F', label: 'Gold', group: 'Commodity' },
  { symbol: 'SI=F', label: 'Silver', group: 'Commodity' },
  { symbol: 'HG=F', label: 'Copper', group: 'Commodity' },
  { symbol: 'ZC=F', label: 'Corn', group: 'Commodity' },
  { symbol: 'ZS=F', label: 'Soybeans', group: 'Commodity' },
  { symbol: 'ZW=F', label: 'Wheat', group: 'Commodity' },
  { symbol: 'BTC=F', label: 'CME Bitcoin', group: 'Crypto' },
  { symbol: 'ETH=F', label: 'CME Ether', group: 'Crypto' },
];

/** Quotes that priced, plus the provider names that answered. Throws when none did. */
async function quoted(ctx: Ctx, symbols: string[], what: string): Promise<{ quotes: Quote[]; source: string; missing: string[] }> {
  const quotes = await getQuotes(ctx, symbols);
  const ok = quotes.filter((q) => q.price !== null);
  if (!ok.length) {
    throw new SourceError('Futures quotes', `no provider could price ${what} from this network (${quotes[0]?.source ?? 'no answer'})`);
  }
  return {
    quotes,
    source: [...new Set(ok.map((q) => q.source))].join(', '),
    missing: quotes.filter((q) => q.price === null).map((q) => q.symbol),
  };
}

const QUOTE_NOTE = 'Futures quotes are exchange-delayed (10 minutes or more). The change is from the previous settlement.';

const boardCard: CardDef = {
  id: 'derivatives.futures-board',
  title: 'Front-Month Futures',
  source: 'Market data',
  description: 'Front-month equity-index, Treasury, currency, commodity and CME crypto futures ranked by the move since the last settlement.',
  async run(ctx) {
    const got = await quoted(ctx, FRONT_MONTH.map((f) => f.symbol), 'front-month futures');
    const rows: Row[] = [];
    got.quotes.forEach((q, i) => {
      if (q.price === null) return;
      rows.push({ name: FRONT_MONTH[i].label, group: FRONT_MONTH[i].group, symbol: q.symbol, price: q.price, chg: q.change, pct: q.changePct, prev: q.prevClose });
    });
    rows.sort((a, b) => ((b.pct as number | null) ?? -Infinity) - ((a.pct as number | null) ?? -Infinity));
    const notes = [QUOTE_NOTE];
    if (got.missing.length) notes.push(`No quote for: ${got.missing.join(', ')}.`);
    const stamp = got.quotes.find((q) => q.time)?.time;
    return {
      blocks: [
        {
          kind: 'table',
          title: 'Ranked by change since last settlement',
          columns: [
            { key: 'name', label: 'Contract' },
            { key: 'group', label: 'Group' },
            { key: 'symbol', label: 'Symbol' },
            { key: 'price', label: 'Last', format: 'num' },
            { key: 'chg', label: 'Chg', format: 'signed' },
            { key: 'pct', label: 'Chg %', format: 'signedPct', digits: 2 },
            { key: 'prev', label: 'Prior settle', format: 'num' },
          ],
          rows,
        },
      ],
      source: got.source,
      asOf: stamp,
      notes,
    };
  },
};

const MONTH_CODES = 'FGHJKMNQUVXZ';

/** Dated contract symbols for `count` consecutive delivery months starting `offset` months after `now`. */
export function contractMonths(root: string, exchange: string, now: Date, count: number, offset = 0): { symbol: string; month: string }[] {
  const out: { symbol: string; month: string }[] = [];
  for (let i = 0; i < count; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset + i, 1));
    const yy = String(d.getUTCFullYear()).slice(2);
    out.push({ symbol: `${root}${MONTH_CODES[d.getUTCMonth()]}${yy}.${exchange}`, month: d.toISOString().slice(0, 7) });
  }
  return out;
}

interface RefRates {
  refRates?: { effectiveDate?: string; percentRate?: number; targetRateFrom?: number; targetRateTo?: number }[];
}

const fedFundsCard: CardDef = {
  id: 'derivatives.fed-funds-futures',
  title: 'Fed Funds Futures: Implied Policy Rate',
  source: 'Market data',
  description: 'The average effective federal funds rate implied by 30-day Fed funds futures for each month ahead (100 minus price).',
  async run(ctx) {
    const months = contractMonths('ZQ', 'CBT', ctx.now(), 14);
    const got = await quoted(ctx, months.map((m) => m.symbol), 'Fed funds futures');
    const effr = await ctx.http.json<RefRates>('https://markets.newyorkfed.org/api/rates/unsecured/effr/last/1.json', { source: 'New York Fed', ttl: 3600 });
    const now = effr.refRates?.[0];
    const base = typeof now?.percentRate === 'number' ? now.percentRate : null;
    const rows: Row[] = [];
    got.quotes.forEach((q, i) => {
      if (q.price === null) return;
      const implied = 100 - q.price;
      rows.push({
        month: months[i].month,
        symbol: q.symbol,
        price: q.price,
        implied,
        vsEffr: base === null ? null : (implied - base) * 100,
        cuts: base === null ? null : (implied - base) / 0.25,
        dayChg: q.change === null ? null : -q.change * 100,
      });
    });
    return {
      blocks: [
        {
          kind: 'stats',
          items: [
            { label: `Effective fed funds rate (${now?.effectiveDate ?? 'latest'})`, value: base, format: 'pct', digits: 2 },
            { label: 'Target range low', value: now?.targetRateFrom, format: 'pct', digits: 2 },
            { label: 'Target range high', value: now?.targetRateTo, format: 'pct', digits: 2 },
            { label: `Implied for ${rows[rows.length - 1]?.month}`, value: rows[rows.length - 1]?.implied, format: 'pct', digits: 2 },
          ],
        },
        {
          kind: 'chart',
          title: 'Implied average fed funds rate by contract month',
          xType: 'category',
          categories: rows.map((r) => String(r.month)),
          yFormat: 'pct',
          yDigits: 2,
          series: [{ name: 'Implied rate', points: rows.map((r, i) => [i, r.implied as number]) }],
        },
        {
          kind: 'table',
          columns: [
            { key: 'month', label: 'Month' },
            { key: 'symbol', label: 'Contract' },
            { key: 'price', label: 'Price', format: 'num', digits: 3 },
            { key: 'implied', label: 'Implied rate', format: 'pct', digits: 3 },
            { key: 'vsEffr', label: 'vs EFFR', format: 'bp' },
            { key: 'cuts', label: '25 bp moves priced', format: 'signed', digits: 1 },
            { key: 'dayChg', label: 'Day chg', format: 'bp', digits: 1 },
          ],
          rows,
        },
      ],
      source: `${got.source}, New York Fed`,
      sourceUrl: 'https://www.cmegroup.com/markets/interest-rates/stirs/30-day-federal-fund.html',
      asOf: got.quotes.find((q) => q.time)?.time,
      notes: [
        'Each contract settles to 100 minus the average daily effective fed funds rate over its month, so the implied rate is a monthly average, not a meeting-date probability.',
        QUOTE_NOTE,
        ...(got.missing.length ? [`No quote for: ${got.missing.join(', ')}.`] : []),
      ],
    };
  },
};

const wtiCard: CardDef = {
  id: 'derivatives.wti-curve',
  title: 'WTI Crude Futures Curve',
  source: 'Market data',
  description: 'NYMEX WTI crude oil futures prices by delivery month, with the spread to the front contract.',
  async run(ctx) {
    const months = contractMonths('CL', 'NYM', ctx.now(), 19, 1);
    const got = await quoted(ctx, months.map((m) => m.symbol), 'WTI futures');
    const rows: Row[] = [];
    let front: number | null = null;
    got.quotes.forEach((q, i) => {
      if (q.price === null) return;
      if (front === null) front = q.price;
      rows.push({ month: months[i].month, symbol: q.symbol, price: q.price, chg: q.change, pct: q.changePct, vsFront: q.price - front });
    });
    const last = rows[rows.length - 1];
    return {
      blocks: [
        {
          kind: 'stats',
          items: [
            { label: `Front (${rows[0].month})`, value: rows[0].price, format: 'usd', digits: 2 },
            { label: `${last.month}`, value: last.price, format: 'usd', digits: 2 },
            { label: 'Back - front', value: last.vsFront, format: 'signed', digits: 2 },
            { label: 'Shape', value: (last.vsFront as number) < 0 ? 'backwardation (front above back)' : 'contango (back above front)' },
          ],
        },
        {
          kind: 'chart',
          title: 'WTI futures by delivery month (USD per barrel)',
          xType: 'category',
          categories: rows.map((r) => String(r.month)),
          yFormat: 'usd',
          yDigits: 2,
          series: [{ name: 'WTI', points: rows.map((r, i) => [i, r.price as number]) }],
        },
        {
          kind: 'table',
          columns: [
            { key: 'month', label: 'Delivery' },
            { key: 'symbol', label: 'Contract' },
            { key: 'price', label: 'Last', format: 'usd', digits: 2 },
            { key: 'chg', label: 'Chg', format: 'signed', digits: 2 },
            { key: 'pct', label: 'Chg %', format: 'signedPct', digits: 2 },
            { key: 'vsFront', label: 'vs front', format: 'signed', digits: 2 },
          ],
          rows,
        },
      ],
      source: got.source,
      sourceUrl: 'https://www.cmegroup.com/markets/energy/crude-oil/light-sweet-crude.html',
      asOf: got.quotes.find((q) => q.time)?.time,
      notes: [QUOTE_NOTE, ...(got.missing.length ? [`No quote for: ${got.missing.join(', ')}.`] : [])],
    };
  },
};

// ---------------------------------------------------------------- CFTC positioning

export interface CotMarket {
  id: string;
  label: string;
  code: string;
  group: string;
}

/** Traders in Financial Futures contracts shown on the positioning tab; `id` is the `series` param value. */
export const COT_MARKETS: CotMarket[] = [
  { id: 'sp500', label: 'E-mini S&P 500', code: '13874A', group: 'Equity index' },
  { id: 'nasdaq100', label: 'E-mini Nasdaq-100', code: '209742', group: 'Equity index' },
  { id: 'russell2000', label: 'E-mini Russell 2000', code: '239742', group: 'Equity index' },
  { id: 'vix', label: 'VIX futures', code: '1170E1', group: 'Equity index' },
  { id: 'ust2y', label: '2-Year T-Note', code: '042601', group: 'Treasury' },
  { id: 'ust5y', label: '5-Year T-Note', code: '044601', group: 'Treasury' },
  { id: 'ust10y', label: '10-Year T-Note', code: '043602', group: 'Treasury' },
  { id: 'ustbond', label: 'T-Bond', code: '020601', group: 'Treasury' },
  { id: 'ultrabond', label: 'Ultra T-Bond', code: '020604', group: 'Treasury' },
  { id: 'eur', label: 'Euro FX', code: '099741', group: 'Currency' },
  { id: 'jpy', label: 'Japanese Yen', code: '097741', group: 'Currency' },
  { id: 'gbp', label: 'British Pound', code: '096742', group: 'Currency' },
  { id: 'cad', label: 'Canadian Dollar', code: '090741', group: 'Currency' },
  { id: 'aud', label: 'Australian Dollar', code: '232741', group: 'Currency' },
  { id: 'chf', label: 'Swiss Franc', code: '092741', group: 'Currency' },
  { id: 'mxn', label: 'Mexican Peso', code: '095741', group: 'Currency' },
  { id: 'btc', label: 'CME Bitcoin', code: '133741', group: 'Crypto' },
];

const COT_NOTE = 'Positions are in contracts, futures only, as of the Tuesday shown; the CFTC publishes them the following Friday. Net = long minus short.';

const cotBoardCard: CardDef = {
  id: 'derivatives.cot-financial',
  title: 'Futures Positioning by Trader Category',
  source: 'CFTC',
  description: 'Latest net positions of dealers, asset managers and leveraged funds in equity-index, Treasury and currency futures, with the week-over-week change.',
  async run(ctx) {
    const got = await Promise.allSettled(COT_MARKETS.map((m) => getCot(ctx, { market: m.code, report: 'financial', weeks: 2 })));
    const rows: Row[] = [];
    const failed: string[] = [];
    let asOf = '';
    got.forEach((g, i) => {
      const m = COT_MARKETS[i];
      if (g.status !== 'fulfilled') {
        failed.push(m.label);
        return;
      }
      const w = g.value.weeks[0];
      if (w.date > asOf) asOf = w.date;
      rows.push({
        contract: m.label,
        group: m.group,
        dealer: w.positions.dealer?.net,
        dealerChg: cotNetChange(g.value.weeks, 'dealer'),
        am: w.positions.assetManager?.net,
        amChg: cotNetChange(g.value.weeks, 'assetManager'),
        lev: w.positions.leveraged?.net,
        levChg: cotNetChange(g.value.weeks, 'leveraged'),
        oi: w.openInterest,
        date: w.date,
      });
    });
    if (!rows.length) {
      const first = got[0];
      throw first.status === 'rejected' && first.reason instanceof Error ? first.reason : new SourceError('CFTC', 'no positioning data');
    }
    return {
      blocks: [
        {
          kind: 'table',
          title: `Traders in Financial Futures, week of ${asOf}`,
          columns: [
            { key: 'contract', label: 'Contract' },
            { key: 'group', label: 'Group' },
            { key: 'dealer', label: 'Dealers net', format: 'int' },
            { key: 'dealerChg', label: 'wk chg', format: 'signed', digits: 0 },
            { key: 'am', label: 'Asset mgrs net', format: 'int' },
            { key: 'amChg', label: 'wk chg', format: 'signed', digits: 0 },
            { key: 'lev', label: 'Lev funds net', format: 'int' },
            { key: 'levChg', label: 'wk chg', format: 'signed', digits: 0 },
            { key: 'oi', label: 'Open interest', format: 'int' },
          ],
          rows,
        },
      ],
      sourceUrl: COT_URL,
      asOf,
      notes: [COT_NOTE, ...(failed.length ? [`No data returned for: ${failed.join(', ')}.`] : [])],
    };
  },
};

const RANGE_WEEKS: Record<string, number> = { '6M': 26, '1Y': 52, '2Y': 104, '3Y': 156, '5Y': 260, '10Y': 520 };

const cotHistoryCard: CardDef = {
  id: 'derivatives.cot-history',
  title: 'Net Position History',
  source: 'CFTC',
  description: 'Weekly net positions by trader category for one futures contract, with the latest long, short and spread detail.',
  params: [
    { name: 'series', label: 'Contract', default: 'sp500', choices: COT_MARKETS.map((m) => m.id), hint: 'one of the listed contracts, or a CFTC contract market code' },
    { name: 'range', label: 'Range', default: '2Y', choices: Object.keys(RANGE_WEEKS) },
  ],
  async run(ctx, params) {
    const want = (params.series ?? 'sp500').trim();
    const known = COT_MARKETS.find((m) => m.id === want.toLowerCase());
    if (!known && !isCotCode(want)) {
      throw new SourceError('CFTC', `unknown contract "${want}" (use ${COT_MARKETS.map((m) => m.id).join(', ')} or a CFTC contract market code)`);
    }
    const weeks = RANGE_WEEKS[(params.range ?? '2Y').toUpperCase()] ?? 104;
    const cot: CotData = await getCot(ctx, { market: known?.code ?? want, report: 'financial', weeks });
    const latest = cot.weeks[0];
    const oi = latest.openInterest;
    const rows: Row[] = cot.categories.map((c) => {
      const p = latest.positions[c.key];
      return {
        category: c.label,
        long: p?.long,
        short: p?.short,
        spread: p?.spread,
        net: p?.net,
        chg: cotNetChange(cot.weeks, c.key),
        pctOi: p && oi ? (p.net / oi) * 100 : null,
      };
    });
    return {
      blocks: [
        {
          kind: 'chart',
          title: `${known?.label ?? cot.market}: net position by trader category (contracts)`,
          xType: 'time',
          yFormat: 'compact',
          series: [
            { name: 'Dealers', points: cotNetSeries(cot.weeks, 'dealer') },
            { name: 'Asset managers', points: cotNetSeries(cot.weeks, 'assetManager') },
            { name: 'Leveraged funds', points: cotNetSeries(cot.weeks, 'leveraged') },
          ],
        },
        {
          kind: 'table',
          title: `${cot.marketAndExchange}, ${latest.date}`,
          columns: [
            { key: 'category', label: 'Category' },
            { key: 'long', label: 'Long', format: 'int' },
            { key: 'short', label: 'Short', format: 'int' },
            { key: 'spread', label: 'Spreading', format: 'int' },
            { key: 'net', label: 'Net', format: 'signed', digits: 0 },
            { key: 'chg', label: 'wk chg', format: 'signed', digits: 0 },
            { key: 'pctOi', label: 'Net % of OI', format: 'signedPct', digits: 1 },
          ],
          rows,
          footnote: `Open interest ${oi?.toLocaleString('en-US') ?? 'n/a'} contracts ${cot.units}. CFTC code ${cot.code}.`,
        },
      ],
      sourceUrl: COT_URL,
      asOf: latest.date,
      notes: [COT_NOTE],
    };
  },
};

export const futuresCards: CardDef[] = [vixCard, boardCard, fedFundsCard, wtiCard, cotBoardCard, cotHistoryCard];
