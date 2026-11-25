/**
 * Crypto derivatives across venues: perpetual funding, open interest, basis,
 * positioning and liquidations. Sources are each venue's public market-data
 * API: Hyperliquid, OKX, Kraken Futures, dYdX, Bitget, Gate and Deribit.
 * (Binance and Bybit refuse U.S. addresses; their funding is read from the
 * comparison feed Hyperliquid publishes.)
 */
import { SourceError, type CardDef, type Ctx, type ParamSpec, type Row } from '../../types.js';
import { deribit } from '../derivatives/deribit.js';
import { DAY, baseOf, list, minuteStamp, n, rec, share, str, sum, titleCase } from './util.js';

export const HL = 'Hyperliquid';
export const OKX = 'OKX';
export const KRAKEN_FUTURES = 'Kraken Futures';
export const DYDX = 'dYdX';

const COIN_PARAM: ParamSpec = { name: 'symbol', label: 'Coin', default: 'BTC-USD', hint: 'coin, e.g. BTC, ETH, SOL' };
const MAJORS = ['BTC', 'ETH', 'SOL', 'XRP', 'BNB', 'DOGE', 'HYPE', 'ADA', 'AVAX', 'LINK', 'SUI', 'LTC', 'BCH', 'DOT', 'UNI', 'AAVE', 'NEAR', 'TRX', 'TON', 'XLM', 'APT', 'ARB', 'OP', 'ENA', 'PEPE'];

/** A per-period funding rate (fraction) to percent a year. */
export function annualise(rate: number | null | undefined, intervalHours: number): number | null {
  if (rate == null || !(intervalHours > 0)) return null;
  return rate * (24 / intervalHours) * 365 * 100;
}

async function hyperliquid<T>(ctx: Ctx, type: string, ttl = 60): Promise<T> {
  return ctx.http.json<T>('https://api.hyperliquid.xyz/info', { source: HL, ttl, body: { type } });
}

async function okx(ctx: Ctx, path: string, ttl = 60): Promise<unknown[]> {
  const body = rec(await ctx.http.json<unknown>(`https://www.okx.com/api/v5${path}`, { source: OKX, ttl }));
  if (str(body.code) !== '0') throw new SourceError(OKX, str(body.msg) || `error ${str(body.code)}`);
  return list(body.data);
}

// ---------------------------------------------------------------- Hyperliquid

export interface HlPerp {
  coin: string;
  mark: number;
  prevDay: number | null;
  /** Hourly funding rate, as a fraction. */
  funding: number | null;
  /** Open interest in coins. */
  openInterest: number | null;
  /** 24-hour notional volume, USD. */
  volume: number | null;
  premium: number | null;
}

/** Hyperliquid `metaAndAssetCtxs`: [meta with the universe, one context per asset in the same order]. */
export function parseHlPerps(body: unknown): HlPerp[] {
  const [meta, ctxs] = list(body);
  const universe = list(rec(meta).universe);
  const out: HlPerp[] = [];
  list(ctxs).forEach((raw, i) => {
    const c = rec(raw);
    const u = rec(universe[i]);
    const mark = n(c.markPx);
    if (!str(u.name) || u.isDelisted === true || mark === null || !(mark > 0)) return;
    out.push({ coin: str(u.name), mark, prevDay: n(c.prevDayPx), funding: n(c.funding), openInterest: n(c.openInterest), volume: n(c.dayNtlVlm), premium: n(c.premium) });
  });
  return out;
}

export interface VenueFunding {
  venue: string;
  rate: number;
  hours: number;
}

const HL_VENUES: Record<string, string> = { BinPerp: 'Binance', BybitPerp: 'Bybit', HlPerp: 'Hyperliquid' };

/** Hyperliquid `predictedFundings`: [[coin, [[venue, {fundingRate, fundingIntervalHours}], ...]], ...]. */
export function parseHlPredicted(body: unknown): Map<string, VenueFunding[]> {
  const out = new Map<string, VenueFunding[]>();
  for (const raw of list(body)) {
    const [coin, venues] = list(raw);
    const rows: VenueFunding[] = [];
    for (const v of list(venues)) {
      const [name, info] = list(v);
      const rate = n(rec(info).fundingRate);
      const hours = n(rec(info).fundingIntervalHours);
      if (rate === null || hours === null || !(hours > 0)) continue;
      rows.push({ venue: HL_VENUES[str(name)] ?? str(name), rate, hours });
    }
    if (str(coin) && rows.length) out.set(str(coin), rows);
  }
  return out;
}

// ---------------------------------------------------------------- Kraken Futures

export interface KrakenFuture {
  symbol: string;
  base: string;
  kind: 'perpetual' | 'dated';
  /** Inverse contracts are sized and margined in dollars of the coin. */
  inverse: boolean;
  /** YYYY-MM-DD for dated contracts. */
  expiry: string | null;
  mark: number;
  index: number | null;
  /** USD. */
  openInterest: number | null;
  /** 24-hour volume, USD. */
  volume: number | null;
  /** Hourly funding as a fraction of notional (perpetuals). */
  funding: number | null;
  change24h: number | null;
}

/** Kraken Futures `GET /derivatives/api/v3/tickers`. Symbols: PF_ and PI_ perpetuals, FF_ and FI_ dated (suffix YYMMDD); the I types are inverse. */
export function parseKrakenFutures(body: unknown): KrakenFuture[] {
  const out: KrakenFuture[] = [];
  for (const raw of list(rec(body).tickers)) {
    const t = rec(raw);
    const m = /^(PF|PI|FF|FI)_([A-Z0-9]+?)USD(?:_(\d{2})(\d{2})(\d{2}))?$/.exec(str(t.symbol));
    const mark = n(t.markPrice);
    if (!m || mark === null || !(mark > 0) || t.suspended === true) continue;
    const inverse = m[1] === 'PI' || m[1] === 'FI';
    const oi = n(t.openInterest);
    const vol = n(t.vol24h);
    out.push({
      symbol: str(t.symbol),
      base: m[2] === 'XBT' ? 'BTC' : m[2],
      kind: m[1][0] === 'P' ? 'perpetual' : 'dated',
      inverse,
      expiry: m[3] ? `20${m[3]}-${m[4]}-${m[5]}` : null,
      mark,
      index: n(t.indexPrice),
      openInterest: oi === null ? null : inverse ? oi : oi * mark,
      volume: inverse ? vol : (n(t.volumeQuote) ?? (vol === null ? null : vol * mark)),
      funding: n(t.relativeFundingRate),
      change24h: n(t.change24h),
    });
  }
  return out;
}

async function krakenFutures(ctx: Ctx): Promise<KrakenFuture[]> {
  const rows = parseKrakenFutures(await ctx.http.json<unknown>('https://futures.kraken.com/derivatives/api/v3/tickers', { source: KRAKEN_FUTURES, ttl: 60 }));
  if (!rows.length) throw new SourceError(KRAKEN_FUTURES, 'no tickers returned');
  return rows;
}

// ---------------------------------------------------------------- dYdX

export interface DydxMarket {
  coin: string;
  price: number;
  /** Hourly funding as a fraction. */
  funding: number | null;
  /** USD. */
  openInterest: number | null;
  volume: number | null;
}

/** dYdX v4 indexer `GET /v4/perpetualMarkets`. */
export function parseDydx(body: unknown): DydxMarket[] {
  const out: DydxMarket[] = [];
  for (const raw of Object.values(rec(rec(body).markets))) {
    const m = rec(raw);
    const price = n(m.oraclePrice);
    const ticker = str(m.ticker);
    if (!ticker.endsWith('-USD') || str(m.status) !== 'ACTIVE' || price === null || !(price > 0)) continue;
    const oi = n(m.openInterest);
    out.push({ coin: ticker.slice(0, -4), price, funding: n(m.nextFundingRate), openInterest: oi === null ? null : oi * price, volume: n(m.volume24H) });
  }
  return out;
}

async function dydx(ctx: Ctx): Promise<DydxMarket[]> {
  const rows = parseDydx(await ctx.http.json<unknown>('https://indexer.dydx.trade/v4/perpetualMarkets', { source: DYDX, ttl: 120 }));
  if (!rows.length) throw new SourceError(DYDX, 'no markets returned');
  return rows;
}

// ---------------------------------------------------------------- funding across venues

const fundingVenues: CardDef = {
  id: 'crypto.funding-venues',
  title: 'Funding Rates Across Venues',
  source: HL,
  description: 'Perpetual funding for the major coins on Binance, Bybit, Hyperliquid, Kraken Futures and dYdX, annualised so venues with different intervals compare.',
  async run(ctx) {
    const [pred, kraken, dy] = await Promise.allSettled([hyperliquid<unknown>(ctx, 'predictedFundings', 120).then(parseHlPredicted), krakenFutures(ctx), dydx(ctx)]);
    if (pred.status === 'rejected' && kraken.status === 'rejected' && dy.status === 'rejected') throw pred.reason;
    const hl = pred.status === 'fulfilled' ? pred.value : new Map<string, VenueFunding[]>();
    const kr = kraken.status === 'fulfilled' ? kraken.value : [];
    const dx = dy.status === 'fulfilled' ? dy.value : [];
    const rows: Row[] = [];
    for (const coin of MAJORS) {
      const v = hl.get(coin) ?? hl.get(`k${coin}`) ?? [];
      const at = (venue: string) => {
        const f = v.find((x) => x.venue === venue);
        return f ? annualise(f.rate, f.hours) : null;
      };
      const k = kr.find((x) => x.base === coin && x.kind === 'perpetual' && !x.inverse);
      const d = dx.find((x) => x.coin === coin && (x.openInterest ?? 0) >= 250_000);
      const row = { coin, binance: at('Binance'), bybit: at('Bybit'), hl: at('Hyperliquid'), kraken: annualise(k?.funding, 1), dydx: annualise(d?.funding, 1) };
      const vals = [row.binance, row.bybit, row.hl, row.kraken, row.dydx].filter((x): x is number => x !== null);
      if (vals.length < 2) continue;
      rows.push({ ...row, avg: sum(vals) / vals.length, gap: vals.length > 1 ? Math.max(...vals) - Math.min(...vals) : null });
    }
    if (!rows.length) throw new SourceError(HL, 'no funding rates returned');
    const pct = { format: 'signedPct' as const, digits: 2 };
    const answered = [pred.status === 'fulfilled' ? HL : '', kraken.status === 'fulfilled' ? KRAKEN_FUTURES : '', dy.status === 'fulfilled' ? DYDX : ''].filter(Boolean);
    return {
      blocks: [
        {
          kind: 'table',
          title: 'Next funding, annualised (% a year, paid by longs when positive)',
          columns: [
            { key: 'coin', label: 'Coin' },
            { key: 'binance', label: 'Binance', ...pct },
            { key: 'bybit', label: 'Bybit', ...pct },
            { key: 'hl', label: 'Hyperliquid', ...pct },
            { key: 'kraken', label: 'Kraken', ...pct },
            { key: 'dydx', label: 'dYdX', ...pct },
            { key: 'avg', label: 'Average', ...pct },
            { key: 'gap', label: 'High minus low', format: 'num', digits: 2 },
          ],
          rows,
        },
      ],
      source: answered.join(', '),
      sourceUrl: 'https://app.hyperliquid.xyz/fundingComparison',
      asOf: minuteStamp(ctx),
      notes: [
        'Each venue\'s predicted rate for the current period, scaled to a year: Binance and Bybit usually settle every 8 hours (some markets every 4), the others every hour. Rates move every period, so an annualised figure is a pace, not a forecast.',
        'Binance and Bybit do not serve U.S. addresses; their rates are the ones Hyperliquid publishes in its funding comparison feed. Hyperliquid funding rests at about 10.95% a year when a market trades at its index. dYdX is shown for markets with at least $250,000 of open interest.',
        ...(answered.length < 3 ? [`Not answering now: ${[HL, KRAKEN_FUTURES, DYDX].filter((s) => !answered.includes(s)).join(', ')}.`] : []),
      ],
    };
  },
};

const hlPerps: CardDef = {
  id: 'crypto.hyperliquid-perps',
  title: 'Hyperliquid Perpetuals',
  source: HL,
  description: 'The largest perpetuals on Hyperliquid by open interest: mark price, 24-hour change, funding, open interest and volume.',
  params: [{ name: 'sort', label: 'Sort by', default: 'open interest', choices: ['open interest', 'volume', 'funding high', 'funding low'] }],
  async run(ctx, params) {
    const all = parseHlPerps(await hyperliquid<unknown>(ctx, 'metaAndAssetCtxs', 60));
    if (!all.length) throw new SourceError(HL, 'no markets returned');
    const withOi = all.map((p) => ({ ...p, oiUsd: p.openInterest === null ? null : p.openInterest * p.mark }));
    const liquid = withOi.filter((p) => (p.oiUsd ?? 0) >= 2_000_000);
    const sorted =
      params.sort === 'volume'
        ? [...withOi].sort((a, b) => (b.volume ?? 0) - (a.volume ?? 0))
        : params.sort === 'funding high'
          ? [...liquid].sort((a, b) => (b.funding ?? -1) - (a.funding ?? -1))
          : params.sort === 'funding low'
            ? [...liquid].sort((a, b) => (a.funding ?? 1) - (b.funding ?? 1))
            : [...withOi].sort((a, b) => (b.oiUsd ?? 0) - (a.oiUsd ?? 0));
    const totalOi = sum(withOi.map((p) => p.oiUsd));
    return {
      blocks: [
        {
          kind: 'stats',
          items: [
            { label: 'Open interest', value: totalOi, format: 'usdCompact' },
            { label: '24h volume', value: sum(withOi.map((p) => p.volume)), format: 'usdCompact' },
            { label: 'Markets', value: all.length, format: 'int' },
            { label: 'BTC and ETH share', value: share(sum(withOi.filter((p) => p.coin === 'BTC' || p.coin === 'ETH').map((p) => p.oiUsd)), totalOi), format: 'pct' },
          ],
        },
        {
          kind: 'table',
          columns: [
            { key: 'coin', label: 'Market' },
            { key: 'mark', label: 'Mark', format: 'usd' },
            { key: 'chg', label: '24h', format: 'signedPct' },
            { key: 'fundingAnn', label: 'Funding, annualised', format: 'signedPct', digits: 2 },
            { key: 'premium', label: 'Premium, bp', format: 'signed', digits: 1 },
            { key: 'oiUsd', label: 'Open interest', format: 'usdCompact' },
            { key: 'volume', label: '24h volume', format: 'usdCompact' },
          ],
          rows: sorted.slice(0, 40).map((p) => ({
            coin: p.coin,
            mark: p.mark,
            chg: p.prevDay ? (p.mark / p.prevDay - 1) * 100 : null,
            fundingAnn: annualise(p.funding, 1),
            premium: p.premium === null ? null : p.premium * 10_000,
            oiUsd: p.oiUsd,
            volume: p.volume,
          })),
        },
      ],
      sourceUrl: 'https://app.hyperliquid.xyz/trade',
      asOf: minuteStamp(ctx),
      notes: ['Funding settles every hour on Hyperliquid; the annualised figure is the current hourly rate times 8,760. Premium is the mark against the oracle price. Sorting by funding keeps markets with at least $2M of open interest.'],
    };
  },
};

// ---------------------------------------------------------------- OKX

export interface OkxSwap {
  instId: string;
  base: string;
  quote: string;
  last: number;
  open24h: number | null;
  /** 24-hour volume in the coin. */
  volumeCoin: number | null;
  oiUsd: number | null;
}

/** OKX `market/tickers?instType=SWAP` joined to `public/open-interest?instType=SWAP` on instId. */
export function parseOkxSwaps(tickers: unknown[], openInterest: unknown[]): OkxSwap[] {
  const oi = new Map<string, number>();
  for (const raw of openInterest) {
    const o = rec(raw);
    const usd = n(o.oiUsd);
    if (str(o.instId) && usd !== null) oi.set(str(o.instId), usd);
  }
  const out: OkxSwap[] = [];
  for (const raw of tickers) {
    const t = rec(raw);
    const m = /^([A-Z0-9]+)-(USDT|USDC|USD)-SWAP$/.exec(str(t.instId));
    const last = n(t.last);
    if (!m || last === null || !(last > 0)) continue;
    out.push({ instId: m[0], base: m[1], quote: m[2], last, open24h: n(t.open24h), volumeCoin: n(t.volCcy24h), oiUsd: oi.get(m[0]) ?? null });
  }
  return out;
}

async function okxSwaps(ctx: Ctx): Promise<OkxSwap[]> {
  const [tickers, oi] = await Promise.all([okx(ctx, '/market/tickers?instType=SWAP', 60), okx(ctx, '/public/open-interest?instType=SWAP', 60)]);
  const rows = parseOkxSwaps(tickers, oi);
  if (!rows.length) throw new SourceError(OKX, 'no perpetual swaps returned');
  return rows;
}

const okxPerps: CardDef = {
  id: 'crypto.okx-perps',
  title: 'OKX Perpetuals',
  source: OKX,
  description: 'The largest perpetual swaps on OKX by open interest: last price, 24-hour change, open interest and volume.',
  async run(ctx) {
    const all = await okxSwaps(ctx);
    const sorted = [...all].sort((a, b) => (b.oiUsd ?? 0) - (a.oiUsd ?? 0));
    const vol = (s: OkxSwap) => (s.volumeCoin === null ? null : s.volumeCoin * s.last);
    return {
      blocks: [
        {
          kind: 'stats',
          items: [
            { label: 'Open interest', value: sum(all.map((s) => s.oiUsd)), format: 'usdCompact' },
            { label: '24h volume', value: sum(all.map(vol)), format: 'usdCompact' },
            { label: 'Swaps listed', value: all.length, format: 'int' },
          ],
        },
        {
          kind: 'table',
          columns: [
            { key: 'instId', label: 'Swap' },
            { key: 'last', label: 'Last', format: 'usd' },
            { key: 'chg', label: '24h', format: 'signedPct' },
            { key: 'oiUsd', label: 'Open interest', format: 'usdCompact' },
            { key: 'volume', label: '24h volume', format: 'usdCompact' },
            { key: 'turn', label: 'Volume / OI', format: 'num', digits: 2 },
          ],
          rows: sorted.slice(0, 40).map((s) => {
            const v = vol(s);
            return { instId: s.instId, last: s.last, chg: s.open24h ? (s.last / s.open24h - 1) * 100 : null, oiUsd: s.oiUsd, volume: v, turn: v !== null && s.oiUsd ? v / s.oiUsd : null };
          }),
        },
      ],
      sourceUrl: 'https://www.okx.com/markets/prices',
      asOf: minuteStamp(ctx),
      notes: ['USDT and USDC swaps are linear; the -USD swaps are inverse, margined in the coin. Open interest is OKX\'s own dollar figure. OKX also lists swaps on stocks, indices and metals; they are ranked here with the coins.'],
    };
  },
};

// ---------------------------------------------------------------- open interest by venue

interface VenueOi {
  venue: string;
  instrument: string;
  oi: number | null;
  volume: number | null;
  funding: number | null;
}

/** Bitget `mix/market/tickers?productType=USDT-FUTURES`: one row per symbol. */
export function parseBitget(body: unknown, coin: string): { oi: number | null; volume: number | null } | null {
  const t = list(rec(body).data).map(rec).find((x) => str(x.symbol) === `${coin}USDT`);
  if (!t) return null;
  const mark = n(t.markPrice) ?? n(t.lastPr);
  const held = n(t.holdingAmount);
  return { oi: held !== null && mark !== null ? held * mark : null, volume: n(t.usdtVolume) };
}

/** Gate `futures/usdt/contracts/{COIN}_USDT`: position_size is in contracts of quanto_multiplier coins. */
export function parseGate(body: unknown): { oi: number | null; funding: number | null } | null {
  const c = rec(body);
  const mark = n(c.mark_price);
  const size = n(c.position_size);
  const mult = n(c.quanto_multiplier);
  if (mark === null) return null;
  const hours = (n(c.funding_interval) ?? 28_800) / 3600;
  return { oi: size !== null && mult !== null ? size * mult * mark : null, funding: annualise(n(c.funding_rate), hours) };
}

const oiVenues: CardDef = {
  id: 'crypto.open-interest',
  title: 'Open Interest by Venue',
  source: 'Exchange public APIs',
  description: 'Perpetual open interest, 24-hour volume and funding for one coin on OKX, Hyperliquid, Bitget, Gate, Deribit, Kraken Futures and dYdX.',
  params: [COIN_PARAM],
  async run(ctx, params) {
    const coin = baseOf(params.symbol);
    const tasks: Promise<VenueOi[]>[] = [
      okxSwaps(ctx).then((all) =>
        all
          .filter((s) => s.base === coin)
          .map((s) => ({ venue: OKX, instrument: s.instId, oi: s.oiUsd, volume: s.volumeCoin === null ? null : s.volumeCoin * s.last, funding: null })),
      ),
      hyperliquid<unknown>(ctx, 'metaAndAssetCtxs', 60).then((b) =>
        parseHlPerps(b)
          .filter((p) => p.coin === coin)
          .map((p) => ({ venue: HL, instrument: `${p.coin}-USD`, oi: p.openInterest === null ? null : p.openInterest * p.mark, volume: p.volume, funding: annualise(p.funding, 1) })),
      ),
      ctx.http.json<unknown>('https://api.bitget.com/api/v2/mix/market/tickers?productType=USDT-FUTURES', { source: 'Bitget', ttl: 60 }).then((b) => {
        const r = parseBitget(b, coin);
        return r ? [{ venue: 'Bitget', instrument: `${coin}USDT`, oi: r.oi, volume: r.volume, funding: null }] : [];
      }),
      ctx.http.json<unknown>(`https://api.gateio.ws/api/v4/futures/usdt/contracts/${coin}_USDT`, { source: 'Gate', ttl: 60 }).then((b) => {
        const r = parseGate(b);
        return r ? [{ venue: 'Gate', instrument: `${coin}_USDT`, oi: r.oi, volume: null, funding: r.funding }] : [];
      }),
      krakenFutures(ctx).then((all) =>
        all.filter((k) => k.base === coin && k.kind === 'perpetual').map((k) => ({ venue: KRAKEN_FUTURES, instrument: k.symbol, oi: k.openInterest, volume: k.volume, funding: k.inverse ? null : annualise(k.funding, 1) })),
      ),
      dydx(ctx).then((all) => all.filter((d) => d.coin === coin).map((d) => ({ venue: DYDX, instrument: `${d.coin}-USD`, oi: d.openInterest, volume: d.volume, funding: annualise(d.funding, 1) }))),
    ];
    if (coin === 'BTC' || coin === 'ETH') {
      tasks.push(
        deribit<Record<string, unknown>>(ctx, 'ticker', { instrument_name: `${coin}-PERPETUAL` }, 60).then((t) => [
          { venue: 'Deribit', instrument: `${coin}-PERPETUAL`, oi: n(t.open_interest), volume: n(rec(t.stats).volume_usd), funding: annualise(n(t.current_funding), 8) },
        ]),
      );
    }
    const got = await Promise.allSettled(tasks);
    const rows = got.flatMap((g) => (g.status === 'fulfilled' ? g.value : [])).filter((r) => (r.oi ?? 0) > 0);
    if (!rows.length) throw new SourceError('Exchange public APIs', `no venue lists a ${coin} perpetual`);
    rows.sort((a, b) => (b.oi ?? 0) - (a.oi ?? 0));
    const total = sum(rows.map((r) => r.oi));
    const byVenue = new Map<string, number>();
    for (const r of rows) byVenue.set(r.venue, (byVenue.get(r.venue) ?? 0) + (r.oi ?? 0));
    const venues = [...byVenue.entries()].sort((a, b) => b[1] - a[1]);
    const failed = got.filter((g) => g.status === 'rejected').length;
    return {
      blocks: [
        {
          kind: 'stats',
          items: [
            { label: `${coin} open interest`, value: total, format: 'usdCompact' },
            { label: '24h volume', value: sum(rows.map((r) => r.volume)), format: 'usdCompact' },
            { label: 'Largest venue', value: venues[0][0] },
            { label: 'Its share', value: share(venues[0][1], total), format: 'pct' },
          ],
        },
        {
          kind: 'chart',
          title: `${coin} perpetual open interest by venue (USD)`,
          xType: 'category',
          style: 'bar',
          yFormat: 'usdCompact',
          categories: venues.map((v) => v[0]),
          series: [{ name: 'Open interest', points: venues.map((v, i): [number, number] => [i, v[1]]) }],
        },
        {
          kind: 'table',
          columns: [
            { key: 'venue', label: 'Venue' },
            { key: 'instrument', label: 'Instrument' },
            { key: 'oi', label: 'Open interest', format: 'usdCompact' },
            { key: 'share', label: 'Share', format: 'pct' },
            { key: 'volume', label: '24h volume', format: 'usdCompact' },
            { key: 'funding', label: 'Funding, annualised', format: 'signedPct', digits: 2 },
          ],
          rows: rows.map((r) => ({ ...r, share: share(r.oi, total) })),
        },
      ],
      source: venues.map((v) => v[0]).join(', '),
      asOf: minuteStamp(ctx),
      notes: [
        'Open interest is each venue\'s own figure in dollars (contracts times the mark price where the venue reports contracts). Binance and Bybit, the two largest venues, do not serve U.S. addresses and are not included, so this is not the whole market.',
        ...(failed ? [`${failed} venue${failed > 1 ? 's' : ''} did not answer.`] : []),
      ],
    };
  },
};

// ---------------------------------------------------------------- positioning (OKX)

/** OKX rubik rows ([ts, a, b?] as text, newest first) to ascending numeric rows. */
export function parseRubik(rows: unknown[]): number[][] {
  const out: number[][] = [];
  for (const raw of rows) {
    const nums = list(raw).map((v) => n(v));
    if (nums.length >= 2 && nums.every((v) => v !== null)) out.push(nums as number[]);
  }
  return out.sort((a, b) => a[0] - b[0]);
}

const positioning: CardDef = {
  id: 'crypto.positioning',
  title: 'Long/Short Ratio and Taker Flow',
  source: OKX,
  description: 'OKX futures positioning for one coin: accounts net long against net short, taker buy and sell volume, and open interest, daily.',
  params: [COIN_PARAM],
  async run(ctx, params) {
    const coin = baseOf(params.symbol);
    const [ls, oiVol, taker] = await Promise.all([
      okx(ctx, `/rubik/stat/contracts/long-short-account-ratio?ccy=${coin}&period=1D`, 900).then(parseRubik),
      okx(ctx, `/rubik/stat/contracts/open-interest-volume?ccy=${coin}&period=1D`, 900).then(parseRubik),
      okx(ctx, `/rubik/stat/taker-volume?ccy=${coin}&instType=CONTRACTS&period=1D`, 900).then(parseRubik),
    ]);
    if (!ls.length) throw new SourceError(OKX, `no positioning data for ${coin}`);
    const lastLs = ls[ls.length - 1];
    const lastOi = oiVol[oiVol.length - 1];
    const byDay = new Map<number, Row>();
    const row = (t: number) => {
      const r = byDay.get(t) ?? { day: t };
      byDay.set(t, r);
      return r;
    };
    for (const r of ls) row(r[0]).ratio = r[1];
    for (const r of oiVol) Object.assign(row(r[0]), { oi: r[1], volume: r[2] });
    for (const r of taker) Object.assign(row(r[0]), { sell: r[1], buy: r[2], net: r[2] - r[1] });
    const table = [...byDay.values()].sort((a, b) => (b.day as number) - (a.day as number)).slice(0, 21);
    const ratios = ls.slice(-90).map((r) => r[1]);
    return {
      blocks: [
        {
          kind: 'stats',
          items: [
            { label: 'Long/short account ratio', value: lastLs[1], format: 'num', digits: 2 },
            { label: 'Accounts net long', value: (lastLs[1] / (1 + lastLs[1])) * 100, format: 'pct' },
            { label: '90-day low', value: Math.min(...ratios), format: 'num', digits: 2 },
            { label: '90-day high', value: Math.max(...ratios), format: 'num', digits: 2 },
            { label: 'Open interest', value: lastOi?.[1], format: 'usdCompact' },
            { label: 'Volume, last day', value: lastOi?.[2], format: 'usdCompact' },
          ],
        },
        { kind: 'chart', title: `${coin}: accounts net long divided by accounts net short`, xType: 'time', yFormat: 'num', yDigits: 2, series: [{ name: 'Long/short ratio', points: ls.map((r): [number, number] => [r[0], r[1]]) }] },
        { kind: 'chart', title: `${coin}: futures and swap open interest on OKX (USD)`, xType: 'time', yFormat: 'usdCompact', series: [{ name: 'Open interest', points: oiVol.map((r): [number, number] => [r[0], r[1]]) }] },
        {
          kind: 'table',
          title: 'By day, newest first',
          columns: [
            { key: 'day', label: 'Day', format: 'date' },
            { key: 'ratio', label: 'Long/short', format: 'num', digits: 2 },
            { key: 'oi', label: 'Open interest', format: 'usdCompact' },
            { key: 'volume', label: 'Volume', format: 'usdCompact' },
            { key: 'buy', label: 'Taker buys', format: 'usdCompact' },
            { key: 'sell', label: 'Taker sells', format: 'usdCompact' },
            { key: 'net', label: 'Net taker', format: 'signed', digits: 0 },
          ],
          rows: table,
        },
      ],
      sourceUrl: 'https://www.okx.com/markets/data/contracts',
      asOf: new Date(lastLs[0]).toISOString().slice(0, 10),
      notes: [
        'The ratio counts accounts, not money: above 1 means more OKX accounts are net long than net short, which is usual because large traders hold the other side. It covers OKX only.',
        'Taker volume is trades that hit the book: buys lift offers, sells hit bids. Days run on OKX\'s clock (UTC+8).',
      ],
    };
  },
};

// ---------------------------------------------------------------- liquidations (OKX)

export interface Liquidation {
  t: number;
  /** The side that was liquidated. */
  side: 'long' | 'short';
  price: number;
  /** Contracts. */
  size: number;
}

/** OKX `public/liquidation-orders` to fills, newest first. A liquidated long is closed with a sell. */
export function parseLiquidations(rows: unknown[]): Liquidation[] {
  const out: Liquidation[] = [];
  for (const raw of rows) {
    for (const d of list(rec(raw).details)) {
      const x = rec(d);
      const price = n(x.bkPx);
      const size = n(x.sz);
      const t = n(x.ts);
      if (price === null || size === null || t === null) continue;
      const pos = str(x.posSide);
      out.push({ t, side: pos === 'long' || pos === 'short' ? pos : str(x.side) === 'sell' ? 'long' : 'short', price, size });
    }
  }
  return out.sort((a, b) => b.t - a.t);
}

const liquidations: CardDef = {
  id: 'crypto.liquidations',
  title: 'Recent Liquidations',
  source: OKX,
  description: 'The latest forced closes on the OKX USDT perpetual for one coin: which side was liquidated, at what price and how large.',
  params: [COIN_PARAM],
  async run(ctx, params) {
    const coin = baseOf(params.symbol);
    const instId = `${coin}-USDT-SWAP`;
    const [fills, inst] = await Promise.all([
      okx(ctx, `/public/liquidation-orders?instType=SWAP&uly=${coin}-USDT&state=filled`, 60).then(parseLiquidations),
      okx(ctx, `/public/instruments?instType=SWAP&instId=${instId}`, 86_400),
    ]);
    if (!fills.length) throw new SourceError(OKX, `no recent liquidations on ${instId}`);
    const ctVal = n(rec(inst[0]).ctVal) ?? 1;
    const usd = (f: Liquidation) => f.size * ctVal * f.price;
    const longs = fills.filter((f) => f.side === 'long');
    const shorts = fills.filter((f) => f.side === 'short');
    const span = (fills[0].t - fills[fills.length - 1].t) / 3_600_000;
    const biggest = fills.reduce((m, f) => (usd(f) > usd(m) ? f : m), fills[0]);
    const lv = sum(longs.map(usd));
    const sv = sum(shorts.map(usd));
    return {
      blocks: [
        {
          kind: 'stats',
          items: [
            { label: 'Liquidations listed', value: fills.length, format: 'int' },
            { label: 'Spanning (hours)', value: span, format: 'num', digits: 1 },
            { label: 'Longs liquidated', value: lv, format: 'usdCompact' },
            { label: 'Shorts liquidated', value: sv, format: 'usdCompact' },
            { label: 'Long share', value: share(lv, lv + sv), format: 'pct' },
            { label: 'Largest', value: usd(biggest), format: 'usdCompact' },
          ],
        },
        {
          kind: 'table',
          title: `${instId}: newest first`,
          columns: [
            { key: 'time', label: 'Time (UTC)', format: 'datetime' },
            { key: 'side', label: 'Liquidated' },
            { key: 'price', label: 'Bankruptcy price', format: 'usd' },
            { key: 'coins', label: `Size (${coin})`, format: 'num', digits: 4 },
            { key: 'usd', label: 'Notional', format: 'usdCompact' },
          ],
          rows: fills.slice(0, 40).map((f) => ({ time: f.t, side: f.side, price: f.price, coins: f.size * ctVal, usd: usd(f) })),
        },
      ],
      sourceUrl: 'https://www.okx.com/markets/data/contracts',
      asOf: new Date(fills[0].t).toISOString().slice(0, 19) + 'Z',
      notes: ['The last 100 liquidation fills OKX publishes for this swap, so the window is short when the market is moving. One venue only: market-wide liquidation totals need Binance and Bybit, which do not serve U.S. addresses.'],
    };
  },
};

// ---------------------------------------------------------------- funding history (OKX)

export interface FundingPoint {
  t: number;
  rate: number;
}

/** OKX `public/funding-rate-history` to settled rates, oldest first. */
export function parseOkxFundingHistory(rows: unknown[]): FundingPoint[] {
  const out: FundingPoint[] = [];
  for (const raw of rows) {
    const r = rec(raw);
    const t = n(r.fundingTime);
    const rate = n(r.realizedRate) ?? n(r.fundingRate);
    if (t !== null && rate !== null) out.push({ t, rate });
  }
  return out.sort((a, b) => a.t - b.t);
}

const fundingHistory: CardDef = {
  id: 'crypto.funding-history',
  title: 'Funding Rate History',
  source: OKX,
  description: 'Settled funding on the OKX USDT perpetual for any listed coin: each period\'s rate, the current rate, and averages annualised.',
  params: [COIN_PARAM],
  async run(ctx, params) {
    const coin = baseOf(params.symbol);
    const instId = `${coin}-USDT-SWAP`;
    const [hist, now] = await Promise.all([okx(ctx, `/public/funding-rate-history?instId=${instId}&limit=100`, 600).then(parseOkxFundingHistory), okx(ctx, `/public/funding-rate?instId=${instId}`, 60)]);
    if (hist.length < 2) throw new SourceError(OKX, `no funding history for ${instId}`);
    const hours = Math.max(1, Math.round((hist[hist.length - 1].t - hist[hist.length - 2].t) / 3_600_000));
    const last = hist[hist.length - 1];
    const avg = (days: number) => {
      const rows = hist.filter((h) => h.t > last.t - days * DAY);
      return rows.length ? annualise(sum(rows.map((r) => r.rate)) / rows.length, hours) : null;
    };
    const cur = n(rec(now[0]).fundingRate);
    const spanDays = (last.t - hist[0].t) / DAY;
    return {
      blocks: [
        {
          kind: 'stats',
          items: [
            { label: 'Current rate', value: cur === null ? null : cur * 100, format: 'pct', digits: 4 },
            { label: 'Current, annualised', value: annualise(cur, hours), format: 'signedPct', digits: 2 },
            { label: 'Last settled', value: last.rate * 100, format: 'pct', digits: 4 },
            { label: '7-day avg, annualised', value: avg(7), format: 'signedPct', digits: 2 },
            { label: `${Math.round(spanDays)}-day avg, annualised`, value: avg(spanDays + 1), format: 'signedPct', digits: 2 },
            { label: `Paid by longs, ${Math.round(spanDays)} days`, value: sum(hist.map((h) => h.rate)) * 100, format: 'signedPct', digits: 3 },
            { label: 'Periods negative', value: share(hist.filter((h) => h.rate < 0).length, hist.length), format: 'pct', digits: 0 },
            { label: 'Settles every (hours)', value: hours, format: 'int' },
          ],
        },
        { kind: 'chart', title: `${instId}: settled funding rate per period (%)`, xType: 'time', yFormat: 'pct', yDigits: 4, series: [{ name: 'Funding', points: hist.map((h): [number, number] => [h.t, h.rate * 100]) }] },
        {
          kind: 'table',
          title: 'Latest settlements',
          columns: [
            { key: 'time', label: 'Settled (UTC)', format: 'datetime' },
            { key: 'rate', label: 'Rate', format: 'signedPct', digits: 4 },
            { key: 'ann', label: 'Annualised', format: 'signedPct', digits: 2 },
          ],
          rows: hist
            .slice(-12)
            .reverse()
            .map((h) => ({ time: h.t, rate: h.rate * 100, ann: annualise(h.rate, hours) })),
        },
      ],
      sourceUrl: `https://www.okx.com/trade-swap/${instId.toLowerCase()}`,
      asOf: new Date(last.t).toISOString().slice(0, 16) + 'Z',
      notes: ['Positive funding is paid by longs to shorts. The last 100 settlements OKX publishes. The Deribit funding card on the coin dashboard covers BTC and ETH there.'],
    };
  },
};

// ---------------------------------------------------------------- Kraken Futures term structure

const krakenBoard: CardDef = {
  id: 'crypto.kraken-futures',
  title: 'Kraken Futures: Perpetuals and Dated',
  source: KRAKEN_FUTURES,
  description: 'Every Kraken Futures contract on one coin: mark against index, the basis of dated contracts annualised, open interest, volume and funding.',
  params: [COIN_PARAM],
  async run(ctx, params) {
    const coin = baseOf(params.symbol);
    const all = (await krakenFutures(ctx)).filter((k) => k.base === coin);
    if (!all.length) throw new SourceError(KRAKEN_FUTURES, `no ${coin} contracts listed`);
    const now = ctx.now().getTime();
    const rows: Row[] = all
      .map((k) => {
        const days = k.expiry ? (Date.parse(`${k.expiry}T16:00:00Z`) - now) / DAY : null;
        const basisPct = k.index ? (k.mark / k.index - 1) * 100 : null;
        return {
          symbol: k.symbol,
          type: `${k.kind}${k.inverse ? ', inverse' : ''}`,
          expiry: k.expiry ?? 'perpetual',
          days,
          mark: k.mark,
          basisPct,
          ann: days !== null && days > 2 && basisPct !== null ? (basisPct / days) * 365 : null,
          funding: k.kind === 'perpetual' && !k.inverse ? annualise(k.funding, 1) : null,
          oi: k.openInterest,
          volume: k.volume,
        };
      })
      .sort((a, b) => (a.days ?? -1) - (b.days ?? -1) || (b.oi ?? 0) - (a.oi ?? 0));
    const dated = rows.filter((r) => r.ann !== null);
    return {
      blocks: [
        ...(dated.length > 1
          ? [
              {
                kind: 'chart' as const,
                title: `${coin}: annualised basis by days to expiry (%)`,
                xType: 'number' as const,
                xLabel: 'Days to expiry',
                yFormat: 'pct' as const,
                yDigits: 2,
                series: [{ name: 'Annualised basis', points: dated.map((r): [number, number] => [r.days as number, r.ann as number]) }],
              },
            ]
          : []),
        {
          kind: 'table',
          title: `${coin} index ${all.find((k) => k.index)?.index?.toLocaleString('en-US', { maximumFractionDigits: 4 }) ?? ''}`,
          columns: [
            { key: 'symbol', label: 'Contract' },
            { key: 'type', label: 'Type' },
            { key: 'expiry', label: 'Expiry' },
            { key: 'days', label: 'Days', format: 'num', digits: 0 },
            { key: 'mark', label: 'Mark', format: 'usd' },
            { key: 'basisPct', label: 'Basis %', format: 'signedPct', digits: 3 },
            { key: 'ann', label: 'Annualised', format: 'signedPct', digits: 2 },
            { key: 'funding', label: 'Funding, annualised', format: 'signedPct', digits: 2 },
            { key: 'oi', label: 'Open interest', format: 'usdCompact' },
            { key: 'volume', label: '24h volume', format: 'usdCompact' },
          ],
          rows,
        },
      ],
      sourceUrl: 'https://futures.kraken.com/',
      asOf: minuteStamp(ctx),
      notes: ['Basis = mark price over the Kraken index, minus one. Annualised = basis divided by days to expiry times 365 (simple); contracts within two days of expiry are not annualised. PF and FF contracts are linear, PI and FI are inverse.'],
    };
  },
};

// ---------------------------------------------------------------- perp DEX open interest (DefiLlama)

export interface LlamaOi {
  name: string;
  category: string;
  chains: string[];
  oi: number;
  weekAgo: number | null;
  monthAgo: number | null;
}

/** DefiLlama `overview/open-interest`: total24h is the latest open interest in dollars. */
export function parseLlamaOi(body: unknown): LlamaOi[] {
  const out: LlamaOi[] = [];
  for (const raw of list(rec(body).protocols)) {
    const p = rec(raw);
    const oi = n(p.total24h);
    if (!str(p.name) || oi === null || !(oi > 0)) continue;
    out.push({ name: str(p.displayName) || str(p.name), category: str(p.category), chains: list(p.chains).map(str), oi, weekAgo: n(p.total7DaysAgo), monthAgo: n(p.total30DaysAgo) });
  }
  return out.sort((a, b) => b.oi - a.oi);
}

const perpDexOi: CardDef = {
  id: 'crypto.onchain-open-interest',
  title: 'Perp DEXs and Prediction Markets: Open Interest',
  source: 'DefiLlama',
  description: 'Open interest on perpetual DEXs, on-chain options venues and prediction markets as DefiLlama tracks them, largest first, against a week and a month ago.',
  async run(ctx) {
    const body = await ctx.http.json<unknown>('https://api.llama.fi/overview/open-interest?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true', { source: 'DefiLlama', ttl: 1800 });
    const all = parseLlamaOi(body);
    if (!all.length) throw new SourceError('DefiLlama', 'no open interest returned');
    const total = n(rec(body).total24h) ?? sum(all.map((p) => p.oi));
    const chg = (now: number, then: number | null) => (then && then > 0 ? (now / then - 1) * 100 : null);
    return {
      blocks: [
        {
          kind: 'stats',
          items: [
            { label: 'Open interest', value: total, format: 'usdCompact' },
            { label: 'Against a week ago', value: chg(total, n(rec(body).total7DaysAgo)), format: 'signedPct' },
            { label: 'Against a month ago', value: chg(total, n(rec(body).total30DaysAgo)), format: 'signedPct' },
            { label: 'Venues reporting', value: all.length, format: 'int' },
            { label: 'Largest venue share', value: share(all[0].oi, total), format: 'pct' },
          ],
        },
        {
          kind: 'table',
          columns: [
            { key: 'name', label: 'Venue', maxWidth: 28 },
            { key: 'category', label: 'Type' },
            { key: 'chain', label: 'Chain', maxWidth: 20 },
            { key: 'oi', label: 'Open interest', format: 'usdCompact' },
            { key: 'share', label: 'Share', format: 'pct' },
            { key: 'week', label: '7d', format: 'signedPct' },
            { key: 'month', label: '30d', format: 'signedPct' },
          ],
          rows: all.slice(0, 30).map((p) => ({ name: p.name, category: p.category, chain: p.chains.length > 1 ? `${p.chains[0]} +${p.chains.length - 1}` : titleCase(p.chains[0] ?? ''), oi: p.oi, share: share(p.oi, total), week: chg(p.oi, p.weekAgo), month: chg(p.oi, p.monthAgo) })),
        },
      ],
      sourceUrl: 'https://defillama.com/open-interest',
      asOf: minuteStamp(ctx),
      notes: ['Open interest in dollars as DefiLlama collects it from each venue. Includes perpetual venues, options venues and prediction markets, some of which settle off chain; the Type and Chain columns say which.'],
    };
  },
};

export const perpCards: CardDef[] = [fundingVenues, oiVenues, hlPerps, okxPerps, fundingHistory, positioning, liquidations, krakenBoard, perpDexOi];
