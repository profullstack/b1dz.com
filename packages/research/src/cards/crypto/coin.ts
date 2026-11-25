/** One coin: profile and supply, where it trades, the price on each exchange, the spot order book, and its market value through time. */
import { firstOf } from '../../http.js';
import { pctChange } from '../../format.js';
import { SourceError, type CardDef, type Ctx, type Row } from '../../types.js';
import { cumulative } from '../derivatives/crypto.js';
import { PAPRIKA, paprika, paprikaId } from './market-data.js';
import { DAY, SYMBOL_PARAM, baseOf, changeOver, list, median, minuteStamp, n, rec, share, str, sum } from './util.js';

// ---------------------------------------------------------------- profile

const profile: CardDef = {
  id: 'crypto.coin-profile',
  title: 'Coin Profile and Supply',
  source: PAPRIKA,
  description: 'What a coin is, its rank, market value, supply and cap, its record price, and its main links.',
  params: [SYMBOL_PARAM],
  async run(ctx, params) {
    const base = baseOf(params.symbol);
    const { id, coin } = await paprikaId(ctx, base);
    const info = rec(await paprika<unknown>(ctx, `/coins/${encodeURIComponent(id)}`, 21_600));
    const t = coin;
    const links = rec(info.links);
    const first = (k: string) => str(list(links[k])[0]);
    const linkRows: Row[] = [
      ['Website', first('website')],
      ['Explorer', first('explorer')],
      ['Source code', first('source_code')],
      ['White paper', str(rec(info.whitepaper).link)],
      ['Reddit', first('reddit')],
    ]
      .filter((r) => r[1])
      .map((r) => ({ what: r[0], link: r[1] }));
    const mined = t?.supply != null && t.maxSupply ? (t.supply / t.maxSupply) * 100 : null;
    return {
      blocks: [
        {
          kind: 'stats',
          title: `${str(info.name) || base} (${str(info.symbol) || base})`,
          items: [
            { label: 'Price', value: t?.price, format: 'usd' },
            { label: 'Market cap rank', value: n(info.rank) ?? t?.rank, format: 'int' },
            { label: 'Market cap', value: t?.marketCap, format: 'usdCompact' },
            { label: '24h volume', value: t?.volume24h, format: 'usdCompact' },
            { label: 'Volume / market cap', value: share(t?.volume24h, t?.marketCap), format: 'pct' },
            { label: '24h', value: t?.chg24h, format: 'signedPct' },
            { label: '7d', value: t?.chg7d, format: 'signedPct' },
            { label: '30d', value: t?.chg30d, format: 'signedPct' },
            { label: '1Y', value: t?.chg1y, format: 'signedPct' },
            { label: 'Supply', value: t?.supply, format: 'compact' },
            { label: 'Maximum supply', value: t ? (t.maxSupply ?? 'no cap') : null, format: t?.maxSupply ? 'compact' : 'text' },
            { label: 'Share of maximum issued', value: mined, format: 'pct' },
            { label: 'Record price', value: t?.athPrice, format: 'usd' },
            { label: 'Record set', value: t?.athDate },
            { label: 'From record', value: t?.fromAth, format: 'signedPct' },
            { label: 'Type', value: str(info.type) || null },
            { label: 'Consensus', value: str(info.proof_type) || null },
            { label: 'Hash algorithm', value: str(info.hash_algorithm) || null },
            { label: 'Structure', value: str(info.org_structure) || null },
            { label: 'Started', value: str(info.started_at).slice(0, 10) || null },
            { label: 'Open source', value: typeof info.open_source === 'boolean' ? (info.open_source ? 'yes' : 'no') : null },
          ],
        },
        ...(str(info.description) ? [{ kind: 'text' as const, title: 'About', text: str(info.description) }] : []),
        ...(list(info.tags).length ? [{ kind: 'text' as const, title: 'Tags', text: list(info.tags).map((x) => str(rec(x).name)).filter(Boolean).join(', ') }] : []),
        ...(linkRows.length
          ? [
              {
                kind: 'table' as const,
                title: 'Links',
                columns: [
                  { key: 'what', label: 'Link' },
                  { key: 'link', label: 'Address', maxWidth: 70 },
                ],
                rows: linkRows,
              },
            ]
          : []),
      ],
      sourceUrl: `https://coinpaprika.com/coin/${id}/`,
      asOf: minuteStamp(ctx),
      notes: t ? [] : [`${base} is outside the top 500 coins, so only its profile is shown.`],
    };
  },
};

// ---------------------------------------------------------------- venues

export interface Venue {
  exchange: string;
  pair: string;
  category: string;
  price: number | null;
  volume: number;
  share: number | null;
  trust: string;
}

/** CoinPaprika `GET /coins/{id}/markets` to venues, busiest first. Markets the provider flags as outliers are dropped. */
export function parseVenues(body: unknown): Venue[] {
  const out: Venue[] = [];
  for (const raw of list(body)) {
    const m = rec(raw);
    const q = rec(rec(m.quotes).USD);
    const volume = n(q.volume_24h);
    if (!str(m.exchange_name) || volume === null || !(volume > 0) || m.outlier === true) continue;
    out.push({
      exchange: str(m.exchange_name),
      pair: str(m.pair),
      category: str(m.category),
      price: n(q.price),
      volume,
      share: n(m.adjusted_volume_24h_share),
      trust: str(m.trust_score),
    });
  }
  return out.sort((a, b) => b.volume - a.volume);
}

const venues: CardDef = {
  id: 'crypto.coin-venues',
  title: 'Where It Trades',
  source: PAPRIKA,
  description: 'The busiest markets for a coin across exchanges: pair, price, 24-hour volume and share of the coin\'s trading.',
  params: [SYMBOL_PARAM],
  async run(ctx, params) {
    const base = baseOf(params.symbol);
    const { id } = await paprikaId(ctx, base);
    const all = parseVenues(await paprika<unknown>(ctx, `/coins/${encodeURIComponent(id)}/markets`, 1800));
    if (!all.length) throw new SourceError(PAPRIKA, `no markets listed for ${base}`);
    const total = sum(all.map((v) => v.volume));
    const byExchange = new Map<string, number>();
    for (const v of all) byExchange.set(v.exchange, (byExchange.get(v.exchange) ?? 0) + v.volume);
    const exchanges = [...byExchange.entries()].sort((a, b) => b[1] - a[1]);
    const prices = all.slice(0, 40).map((v) => v.price).filter((p): p is number => p !== null);
    const mid = median(prices);
    return {
      blocks: [
        {
          kind: 'stats',
          items: [
            { label: 'Markets', value: all.length, format: 'int' },
            { label: 'Exchanges', value: exchanges.length, format: 'int' },
            { label: '24h volume, all markets', value: total, format: 'usdCompact' },
            { label: 'Busiest exchange', value: exchanges[0]?.[0] },
            { label: 'Its share', value: share(exchanges[0]?.[1], total), format: 'pct' },
            { label: 'Top 5 exchanges', value: share(sum(exchanges.slice(0, 5).map((e) => e[1])), total), format: 'pct' },
          ],
        },
        {
          kind: 'table',
          title: `${base}: busiest markets`,
          columns: [
            { key: 'exchange', label: 'Exchange', maxWidth: 22 },
            { key: 'pair', label: 'Pair' },
            { key: 'category', label: 'Type' },
            { key: 'price', label: 'Price', format: 'usd' },
            { key: 'vsMid', label: 'vs median', format: 'signedPct', digits: 3 },
            { key: 'volume', label: '24h volume', format: 'usdCompact' },
            { key: 'share', label: 'Share', format: 'pct' },
            { key: 'trust', label: 'Trust' },
          ],
          rows: all.slice(0, 30).map((v) => ({ ...v, share: share(v.volume, total), vsMid: v.price !== null && mid ? (v.price / mid - 1) * 100 : null })),
        },
      ],
      sourceUrl: `https://coinpaprika.com/coin/${id}/#!exchanges`,
      asOf: minuteStamp(ctx),
      notes: ['Volumes are what each exchange reports, converted to dollars. Markets the provider flags as outliers are left out. The median is taken over the 40 busiest markets.'],
    };
  },
};

// ---------------------------------------------------------------- cross-exchange price

export interface VenueQuote {
  venue: string;
  pair: string;
  bid: number | null;
  ask: number | null;
  last: number | null;
  /** 24-hour volume in the coin. */
  volume: number | null;
}

const KRAKEN_BASE: Record<string, string> = { BTC: 'XBT', DOGE: 'XDG' };

interface VenueDef {
  name: string;
  quote: 'USD' | 'USDT';
  url(base: string): string;
  parse(body: unknown, base: string): Omit<VenueQuote, 'venue' | 'pair'> | null;
}

/** Each exchange's public ticker endpoint and how to read it. */
export const VENUES: VenueDef[] = [
  {
    name: 'Coinbase',
    quote: 'USD',
    url: (b) => `https://api.exchange.coinbase.com/products/${b}-USD/ticker`,
    parse: (body) => {
      const t = rec(body);
      return n(t.price) === null ? null : { bid: n(t.bid), ask: n(t.ask), last: n(t.price), volume: n(t.volume) };
    },
  },
  {
    name: 'Kraken',
    quote: 'USD',
    url: (b) => `https://api.kraken.com/0/public/Ticker?pair=${KRAKEN_BASE[b] ?? b}USD`,
    parse: (body) => {
      const t = rec(Object.values(rec(rec(body).result))[0]);
      const at = (k: string, i: number) => n(list(t[k])[i]);
      return at('c', 0) === null ? null : { bid: at('b', 0), ask: at('a', 0), last: at('c', 0), volume: at('v', 1) };
    },
  },
  {
    name: 'Gemini',
    quote: 'USD',
    url: (b) => `https://api.gemini.com/v1/pubticker/${b.toLowerCase()}usd`,
    parse: (body, base) => {
      const t = rec(body);
      return n(t.last) === null ? null : { bid: n(t.bid), ask: n(t.ask), last: n(t.last), volume: n(rec(t.volume)[base]) };
    },
  },
  {
    name: 'Bitstamp',
    quote: 'USD',
    url: (b) => `https://www.bitstamp.net/api/v2/ticker/${b.toLowerCase()}usd/`,
    parse: (body) => {
      const t = rec(body);
      return n(t.last) === null ? null : { bid: n(t.bid), ask: n(t.ask), last: n(t.last), volume: n(t.volume) };
    },
  },
  {
    name: 'Binance.US',
    quote: 'USD',
    url: (b) => `https://api.binance.us/api/v3/ticker/24hr?symbol=${b}USD`,
    parse: (body) => {
      const t = rec(body);
      return n(t.lastPrice) === null ? null : { bid: n(t.bidPrice), ask: n(t.askPrice), last: n(t.lastPrice), volume: n(t.volume) };
    },
  },
  {
    name: 'Bitfinex',
    quote: 'USD',
    url: (b) => `https://api-pub.bitfinex.com/v2/ticker/t${b.length > 3 ? `${b}:USD` : `${b}USD`}`,
    parse: (body) => {
      const t = list(body);
      return n(t[6]) === null ? null : { bid: n(t[0]), ask: n(t[2]), last: n(t[6]), volume: n(t[7]) };
    },
  },
  {
    name: 'OKX',
    quote: 'USDT',
    url: (b) => `https://www.okx.com/api/v5/market/ticker?instId=${b}-USDT`,
    parse: (body) => {
      const t = rec(list(rec(body).data)[0]);
      return n(t.last) === null ? null : { bid: n(t.bidPx), ask: n(t.askPx), last: n(t.last), volume: n(t.vol24h) };
    },
  },
];

/** Rows for the comparison table: spread in basis points and each venue's mid against the median mid. */
export function compareQuotes(quotes: VenueQuote[]): { rows: Row[]; mid: number | null; rangeBp: number | null } {
  const mids = quotes.map((q) => (q.bid && q.ask ? (q.bid + q.ask) / 2 : q.last)).filter((m): m is number => m !== null && m > 0);
  const mid = median(mids);
  const rows: Row[] = quotes.map((q) => {
    const m = q.bid && q.ask ? (q.bid + q.ask) / 2 : q.last;
    return {
      venue: q.venue,
      pair: q.pair,
      bid: q.bid,
      ask: q.ask,
      last: q.last,
      spreadBp: q.bid && q.ask ? ((q.ask - q.bid) / ((q.ask + q.bid) / 2)) * 10_000 : null,
      vsMid: m && mid ? (m / mid - 1) * 10_000 : null,
      volume: q.volume !== null && m ? q.volume * m : null,
    };
  });
  const rangeBp = mid && mids.length > 1 ? ((Math.max(...mids) - Math.min(...mids)) / mid) * 10_000 : null;
  return { rows, mid, rangeBp };
}

const priceCompare: CardDef = {
  id: 'crypto.price-compare',
  title: 'Price Across Exchanges',
  source: 'Exchange public APIs',
  description: 'The live bid, ask and last trade for a coin on Coinbase, Kraken, Gemini, Bitstamp, Binance.US, Bitfinex and OKX, with each venue\'s gap to the median.',
  params: [SYMBOL_PARAM],
  async run(ctx, params) {
    const base = baseOf(params.symbol);
    const got = await Promise.allSettled(
      VENUES.map(async (v): Promise<VenueQuote> => {
        const q = v.parse(await ctx.http.json<unknown>(v.url(base), { source: v.name, ttl: 20, timeoutMs: 10_000 }), base);
        if (!q || !(q.last && q.last > 0)) throw new SourceError(v.name, `no ${base} market`);
        return { venue: v.name, pair: `${base}-${v.quote}`, ...q };
      }),
    );
    const quotes = got.flatMap((g) => (g.status === 'fulfilled' ? [g.value] : []));
    const missing = VENUES.filter((_, i) => got[i].status === 'rejected').map((v) => v.name);
    if (!quotes.length) throw new SourceError('Exchange public APIs', `no exchange quoted ${base} against the dollar`);
    const { rows, mid, rangeBp } = compareQuotes(quotes);
    return {
      blocks: [
        {
          kind: 'stats',
          items: [
            { label: 'Median mid price', value: mid, format: 'usd' },
            { label: 'Venues quoting', value: quotes.length, format: 'int' },
            { label: 'High to low (bp)', value: rangeBp, format: 'num', digits: 1 },
            { label: '24h volume, these venues', value: sum(rows.map((r) => r.volume as number | null)), format: 'usdCompact' },
          ],
        },
        {
          kind: 'table',
          columns: [
            { key: 'venue', label: 'Exchange' },
            { key: 'pair', label: 'Pair' },
            { key: 'bid', label: 'Bid', format: 'usd' },
            { key: 'ask', label: 'Ask', format: 'usd' },
            { key: 'last', label: 'Last', format: 'usd' },
            { key: 'spreadBp', label: 'Spread, bp', format: 'num', digits: 2 },
            { key: 'vsMid', label: 'vs median, bp', format: 'signed', digits: 1 },
            { key: 'volume', label: '24h volume', format: 'usdCompact' },
          ],
          rows,
        },
      ],
      source: quotes.map((q) => q.venue).join(', '),
      asOf: ctx.now().toISOString().slice(0, 19) + 'Z',
      notes: [
        'Each row is that exchange\'s own public ticker, read within about 20 seconds of each other. OKX quotes against USDT, so its gap includes the USDT to dollar rate.',
        ...(missing.length ? [`No ${base} dollar market, or no answer, from: ${missing.join(', ')}.`] : []),
      ],
    };
  },
};

// ---------------------------------------------------------------- spot order book

export interface Book {
  /** Best first. */
  bids: [number, number][];
  asks: [number, number][];
}

function levels(v: unknown, descending: boolean): [number, number][] {
  const out: [number, number][] = [];
  for (const l of list(v)) {
    const p = n(list(l)[0]);
    const s = n(list(l)[1]);
    if (p !== null && s !== null && p > 0 && s > 0) out.push([p, s]);
  }
  return out.sort((a, b) => (descending ? b[0] - a[0] : a[0] - b[0]));
}

/** Kraken `Depth` to a book. */
export function parseKrakenDepth(body: unknown): Book {
  const b = rec(Object.values(rec(rec(body).result))[0]);
  return { bids: levels(b.bids, true), asks: levels(b.asks, false) };
}

/** Coinbase Exchange `GET /products/{id}/book?level=2` to a book. */
export function parseCoinbaseBook(body: unknown): Book {
  const b = rec(body);
  return { bids: levels(b.bids, true), asks: levels(b.asks, false) };
}

/** Dollars resting within `pct` percent of the mid on one side. */
export function depthWithin(side: [number, number][], mid: number, pct: number): number {
  let total = 0;
  for (const [price, size] of side) if (Math.abs(price / mid - 1) * 100 <= pct) total += price * size;
  return total;
}

const spotBook: CardDef = {
  id: 'crypto.spot-book',
  title: 'Spot Order Book',
  source: 'Kraken',
  description: 'The dollar order book for a coin: best bid and ask, spread, depth near the price on each side, and the top levels.',
  params: [SYMBOL_PARAM],
  async run(ctx, params) {
    const base = baseOf(params.symbol);
    const got = await firstOf([
      {
        name: 'Kraken',
        run: async () => {
          const body = await ctx.http.json<unknown>(`https://api.kraken.com/0/public/Depth?pair=${KRAKEN_BASE[base] ?? base}USD&count=500`, { source: 'Kraken', ttl: 15 });
          const book = parseKrakenDepth(body);
          if (!book.bids.length || !book.asks.length) throw new SourceError('Kraken', str(list(rec(body).error)[0]) || `no ${base}-USD book`);
          return book;
        },
      },
      {
        name: 'Coinbase',
        run: async () => {
          const book = parseCoinbaseBook(await ctx.http.json<unknown>(`https://api.exchange.coinbase.com/products/${base}-USD/book?level=2`, { source: 'Coinbase', ttl: 15 }));
          if (!book.bids.length || !book.asks.length) throw new SourceError('Coinbase', `no ${base}-USD book`);
          return { bids: book.bids.slice(0, 500), asks: book.asks.slice(0, 500) };
        },
      },
    ]);
    const { bids, asks } = got.value;
    const bb = bids[0][0];
    const ba = asks[0][0];
    const mid = (bb + ba) / 2;
    const bidCum = cumulative(bids);
    const askCum = cumulative(asks);
    const rows: Row[] = [];
    for (let i = 0; i < 15; i++) {
      if (!bids[i] && !asks[i]) break;
      rows.push({ level: i + 1, bidCum: bidCum[i]?.[1], bidSize: bids[i]?.[1], bid: bids[i]?.[0], ask: asks[i]?.[0], askSize: asks[i]?.[1], askCum: askCum[i]?.[1] });
    }
    const near = (side: [number, number][]) => side.filter(([p]) => Math.abs(p / mid - 1) <= 0.02);
    const b1 = depthWithin(bids, mid, 1);
    const a1 = depthWithin(asks, mid, 1);
    return {
      blocks: [
        {
          kind: 'stats',
          items: [
            { label: 'Best bid', value: bb, format: 'usd' },
            { label: 'Best ask', value: ba, format: 'usd' },
            { label: 'Spread', value: ba - bb, format: 'usd' },
            { label: 'Spread, bp of mid', value: ((ba - bb) / mid) * 10_000, format: 'num', digits: 2 },
            { label: 'Bids within 0.5%', value: depthWithin(bids, mid, 0.5), format: 'usdCompact' },
            { label: 'Asks within 0.5%', value: depthWithin(asks, mid, 0.5), format: 'usdCompact' },
            { label: 'Bids within 1%', value: b1, format: 'usdCompact' },
            { label: 'Asks within 1%', value: a1, format: 'usdCompact' },
            { label: 'Bid share of 1% depth', value: share(b1, b1 + a1), format: 'pct' },
          ],
        },
        {
          kind: 'chart',
          title: `${base}-USD: cumulative depth within 2% of the mid (${base})`,
          xType: 'number',
          xLabel: 'Price',
          yFormat: 'compact',
          series: [
            { name: 'Bids', points: cumulative(near(bids)).reverse() },
            { name: 'Asks', points: cumulative(near(asks)) },
          ],
        },
        {
          kind: 'table',
          columns: [
            { key: 'level', label: '#', format: 'int' },
            { key: 'bidCum', label: 'Cum. bid', format: 'num', digits: 3 },
            { key: 'bidSize', label: 'Bid size', format: 'num', digits: 4 },
            { key: 'bid', label: 'Bid', format: 'usd' },
            { key: 'ask', label: 'Ask', format: 'usd' },
            { key: 'askSize', label: 'Ask size', format: 'num', digits: 4 },
            { key: 'askCum', label: 'Cum. ask', format: 'num', digits: 3 },
          ],
          rows,
        },
      ],
      source: got.source,
      sourceUrl: got.source === 'Kraken' ? 'https://pro.kraken.com/app/trade/' + `${base}-USD`.toLowerCase() : `https://www.coinbase.com/advanced-trade/spot/${base}-USD`,
      asOf: ctx.now().toISOString().slice(0, 19) + 'Z',
      notes: [`One exchange's book (${got.source}), up to 500 levels a side; depth further from the price than those levels reach is not counted. Sizes are in ${base}.`, ...got.skipped],
    };
  },
};

// ---------------------------------------------------------------- market cap and volume history

export interface CapPoint {
  t: number;
  price: number;
  marketCap: number | null;
  volume: number | null;
}

/** CoinPaprika `GET /tickers/{id}/historical` to daily points, oldest first. */
export function parsePaprikaHistory(body: unknown): CapPoint[] {
  const out: CapPoint[] = [];
  for (const raw of list(body)) {
    const p = rec(raw);
    const t = Date.parse(str(p.timestamp));
    const price = n(p.price);
    if (Number.isNaN(t) || price === null) continue;
    out.push({ t, price, marketCap: n(p.market_cap), volume: n(p.volume_24h) });
  }
  return out.sort((a, b) => a.t - b.t);
}

const capHistory: CardDef = {
  id: 'crypto.coin-cap-history',
  title: 'Market Cap and Volume, 1 Year',
  source: PAPRIKA,
  description: 'A coin\'s market value and its 24-hour trading volume across all exchanges, daily over the last year.',
  params: [SYMBOL_PARAM],
  async run(ctx, params) {
    const base = baseOf(params.symbol);
    const { id } = await paprikaId(ctx, base);
    const start = new Date(ctx.now().getTime() - 364 * DAY).toISOString().slice(0, 10);
    const pts = parsePaprikaHistory(await paprika<unknown>(ctx, `/tickers/${encodeURIComponent(id)}/historical?start=${start}&interval=1d`, 3600));
    if (pts.length < 2) throw new SourceError(PAPRIKA, `no history for ${base}`);
    const caps = pts.filter((p) => p.marketCap !== null).map((p): [number, number] => [p.t, p.marketCap as number]);
    const vols = pts.filter((p) => p.volume !== null).map((p): [number, number] => [p.t, p.volume as number]);
    const last = pts[pts.length - 1];
    const vol30 = vols.slice(-30).map((v) => v[1]);
    const capValues = caps.map((c) => c[1]);
    return {
      blocks: [
        {
          kind: 'stats',
          items: [
            { label: 'Market cap', value: last.marketCap, format: 'usdCompact' },
            { label: '30 days', value: changeOver(caps, 30), format: 'signedPct' },
            { label: '90 days', value: changeOver(caps, 90), format: 'signedPct' },
            { label: '1 year', value: pctChange(last.marketCap, caps[0]?.[1]), format: 'signedPct' },
            { label: '1-year high', value: capValues.length ? Math.max(...capValues) : null, format: 'usdCompact' },
            { label: '1-year low', value: capValues.length ? Math.min(...capValues) : null, format: 'usdCompact' },
            { label: '24h volume', value: last.volume, format: 'usdCompact' },
            { label: 'Avg daily volume, 30d', value: vol30.length ? sum(vol30) / vol30.length : null, format: 'usdCompact' },
          ],
        },
        { kind: 'chart', title: `${base}: market cap`, xType: 'time', yFormat: 'usdCompact', series: [{ name: 'Market cap', points: caps }] },
        { kind: 'chart', title: `${base}: 24-hour volume, all exchanges`, xType: 'time', yFormat: 'usdCompact', series: [{ name: 'Volume', points: vols }] },
      ],
      sourceUrl: `https://coinpaprika.com/coin/${id}/`,
      asOf: new Date(last.t).toISOString().slice(0, 10),
      notes: ['Daily values at 00:00 UTC. The provider\'s keyless plan goes back one year. Volume is what exchanges report, summed across the venues it tracks.'],
    };
  },
};

export const coinCards: CardDef[] = [profile, venues, priceCompare, spotBook, capHistory];
