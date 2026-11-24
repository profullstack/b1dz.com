/**
 * Yahoo Finance chart endpoint (v8/finance/chart). Unofficial and refused
 * from many data-centre networks, so it is the secondary provider wherever
 * another source exists and the primary only for futures and listings
 * outside the U.S.
 */
import { SourceError, type Ctx } from '../types.js';

export const YAHOO = 'Yahoo Finance';

export interface YahooChart {
  chart?: {
    result?:
      | {
          meta?: {
            currency?: string;
            symbol?: string;
            exchangeName?: string;
            fullExchangeName?: string;
            shortName?: string;
            longName?: string;
            regularMarketPrice?: number;
            regularMarketTime?: number;
            chartPreviousClose?: number;
          };
          timestamp?: number[];
          indicators?: { quote?: { open?: (number | null)[]; high?: (number | null)[]; low?: (number | null)[]; close?: (number | null)[]; volume?: (number | null)[] }[] };
        }[]
      | null;
    error?: { code?: string; description?: string } | null;
  };
}

export interface YahooParsed {
  bars: { t: number; o: number; h: number; l: number; c: number; v: number | null }[];
  currency?: string;
  name?: string;
  exchange?: string;
  price: number | null;
  prevClose: number | null;
  time?: string;
}

const DAY = 86_400_000;

/** Parse a chart response. Bars with no close (holidays, a session in progress with no print) are dropped. */
export function parseYahooChart(body: YahooChart): YahooParsed {
  const r = body.chart?.result?.[0];
  if (!r) throw new SourceError(YAHOO, body.chart?.error?.description ?? 'no result');
  const q = r.indicators?.quote?.[0] ?? {};
  const bars: YahooParsed['bars'] = [];
  (r.timestamp ?? []).forEach((ts, i) => {
    const c = q.close?.[i];
    if (c === null || c === undefined || !Number.isFinite(c)) return;
    // Bars are stamped at the exchange's session open; keep the calendar day only.
    const t = Math.floor((ts * 1000) / DAY) * DAY;
    bars.push({ t, o: q.open?.[i] ?? c, h: q.high?.[i] ?? c, l: q.low?.[i] ?? c, c, v: q.volume?.[i] ?? null });
  });
  const meta = r.meta ?? {};
  const price = meta.regularMarketPrice ?? bars.at(-1)?.c ?? null;
  // Previous close: the last bar before the day of the latest trade.
  let prevClose: number | null = null;
  if (bars.length) {
    const lastDay = meta.regularMarketTime ? Math.floor((meta.regularMarketTime * 1000) / DAY) * DAY : bars[bars.length - 1].t;
    const before = bars.filter((b) => b.t < lastDay);
    prevClose = before.at(-1)?.c ?? meta.chartPreviousClose ?? null;
  }
  return {
    bars,
    currency: meta.currency,
    name: meta.longName ?? meta.shortName,
    exchange: meta.fullExchangeName ?? meta.exchangeName,
    price,
    prevClose,
    time: meta.regularMarketTime ? new Date(meta.regularMarketTime * 1000).toISOString() : undefined,
  };
}

/** Daily bars between two dates, with the quote header. */
export async function yahooChart(ctx: Ctx, symbol: string, from: Date, to: Date, ttl = 1800): Promise<YahooParsed> {
  const p1 = Math.max(0, Math.floor(from.getTime() / 1000));
  const p2 = Math.floor(to.getTime() / 1000) + 86_400;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${p1}&period2=${p2}&interval=1d&events=div%2Csplits`;
  const body = await ctx.http.json<YahooChart>(url, { source: YAHOO, ttl, timeoutMs: 12_000 });
  return parseYahooChart(body);
}
