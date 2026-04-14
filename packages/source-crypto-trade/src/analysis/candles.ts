import { normalizePair } from '@b1dz/source-crypto-arb';
import type { MarketSnapshot } from '@b1dz/core';

export type AnalysisTimeframe = '1m' | '5m' | '15m' | '1h' | '4h' | '1d' | '1w';

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export const TIMEFRAME_TO_MS: Record<AnalysisTimeframe, number> = {
  '1m': 60_000,
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  '1h': 60 * 60_000,
  '4h': 4 * 60 * 60_000,
  '1d': 24 * 60 * 60_000,
  '1w': 7 * 24 * 60 * 60_000,
};

function bucketTime(time: number, timeframe: AnalysisTimeframe): number {
  const size = TIMEFRAME_TO_MS[timeframe];
  return Math.floor(time / size) * size;
}

function toTickPrice(snap: MarketSnapshot): number {
  return Number.isFinite(snap.bid) && snap.bid > 0 && Number.isFinite(snap.ask) && snap.ask > 0
    ? (snap.bid + snap.ask) / 2
    : snap.bid > 0
      ? snap.bid
      : snap.ask;
}

function toTickVolume(snap: MarketSnapshot): number {
  const bidSize = Number.isFinite(snap.bidSize) && snap.bidSize > 0 ? snap.bidSize : 0;
  const askSize = Number.isFinite(snap.askSize) && snap.askSize > 0 ? snap.askSize : 0;
  return Math.max(bidSize, askSize);
}

export function applySnapshotToCandles(
  candles: Candle[],
  snap: MarketSnapshot,
  timeframe: AnalysisTimeframe,
  maxBars = 500,
): Candle[] {
  const next = [...candles];
  const time = bucketTime(snap.ts, timeframe);
  const price = toTickPrice(snap);
  const volume = toTickVolume(snap);
  if (!Number.isFinite(price) || price <= 0) return next;
  const last = next.at(-1);
  if (!last || last.time !== time) {
    next.push({ time, open: price, high: price, low: price, close: price, volume });
  } else {
    last.high = Math.max(last.high, price);
    last.low = Math.min(last.low, price);
    last.close = price;
    last.volume += volume;
  }
  while (next.length > maxBars) next.shift();
  return next;
}

async function fetchJson(url: string) {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${res.status} ${text.slice(0, 160)}`.trim());
  }
  return res.json();
}

function timeframeToKrakenInterval(timeframe: AnalysisTimeframe): number {
  return {
    '1m': 1,
    '5m': 5,
    '15m': 15,
    '1h': 60,
    '4h': 240,
    '1d': 1440,
    '1w': 10080,
  }[timeframe] ?? 5;
}

function timeframeToBinanceInterval(timeframe: AnalysisTimeframe): string {
  return timeframe;
}

function timeframeToGeminiInterval(timeframe: AnalysisTimeframe): string | null {
  // Gemini supports: 1m, 5m, 15m, 30m, 1hr, 6hr, 1day. No 4h or 1w.
  return ({
    '1m': '1m',
    '5m': '5m',
    '15m': '15m',
    '1h': '1hr',
    '4h': '1hr',   // fetch 1hr, aggregate to 4h
    '1d': '1day',
    '1w': '1day',  // fetch 1day, aggregate to 1w
  } as Record<AnalysisTimeframe, string>)[timeframe] ?? '5m';
}

function chooseGeminiFetchTimeframe(timeframe: AnalysisTimeframe): { fetchTimeframe: AnalysisTimeframe; aggregate: AnalysisTimeframe | null } {
  if (timeframe === '4h') return { fetchTimeframe: '1h', aggregate: '4h' };
  if (timeframe === '1w') return { fetchTimeframe: '1d', aggregate: '1w' };
  return { fetchTimeframe: timeframe, aggregate: null };
}

function timeframeToCoinbaseGranularity(timeframe: AnalysisTimeframe): number {
  return {
    '1m': 60,
    '5m': 300,
    '15m': 900,
    '1h': 3600,
    '4h': 14400,
    '1d': 86400,
    '1w': 86400,
  }[timeframe] ?? 300;
}

function chooseCoinbaseFetchTimeframe(timeframe: AnalysisTimeframe): { fetchTimeframe: AnalysisTimeframe; aggregate: AnalysisTimeframe | null } {
  if (timeframe === '4h') return { fetchTimeframe: '1h', aggregate: '4h' };
  if (timeframe === '1w') return { fetchTimeframe: '1d', aggregate: '1w' };
  return { fetchTimeframe: timeframe, aggregate: null };
}

export function aggregateCandles(input: Candle[], timeframe: AnalysisTimeframe): Candle[] {
  const buckets = new Map<number, Candle>();
  for (const candle of input) {
    const time = bucketTime(candle.time, timeframe);
    const current = buckets.get(time);
    if (!current) {
      buckets.set(time, { ...candle, time });
      continue;
    }
    current.high = Math.max(current.high, candle.high);
    current.low = Math.min(current.low, candle.low);
    current.close = candle.close;
    current.volume += candle.volume;
  }
  return [...buckets.values()].sort((a, b) => a.time - b.time);
}

export async function fetchHistoricalCandles(
  exchange: string,
  pair: string,
  timeframe: AnalysisTimeframe,
  limit = 200,
): Promise<Candle[]> {
  try {
    if (exchange === 'kraken') {
      const symbol = normalizePair(pair, 'kraken');
      const interval = timeframeToKrakenInterval(timeframe);
      const data = await fetchJson(`https://api.kraken.com/0/public/OHLC?pair=${encodeURIComponent(symbol)}&interval=${interval}`) as { result?: Record<string, unknown> };
      const result = data.result ?? {};
      const firstSeriesKey = Object.keys(result).find((key) => key !== 'last');
      const series: unknown[][] = Array.isArray(result[symbol])
        ? result[symbol] as unknown[][]
        : Array.isArray(firstSeriesKey ? result[firstSeriesKey] : null)
          ? result[firstSeriesKey!] as unknown[][]
          : [];
      return series.map((row: unknown[]) => ({
        time: Number(row[0]) * 1000,
        open: Number(row[1]),
        high: Number(row[2]),
        low: Number(row[3]),
        close: Number(row[4]),
        volume: Number(row[6] ?? 0),
      })).filter((bar: Candle) => Number.isFinite(bar.close)).slice(-limit);
    }

    if (exchange === 'binance-us') {
      const symbol = normalizePair(pair, 'binance-us');
      const interval = timeframeToBinanceInterval(timeframe);
      const data = await fetchJson(`https://api.binance.us/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${Math.min(limit, 500)}`);
      return Array.isArray(data)
        ? data.map((row: unknown[]) => ({
            time: Number(row[0]),
            open: Number(row[1]),
            high: Number(row[2]),
            low: Number(row[3]),
            close: Number(row[4]),
            volume: Number(row[5] ?? 0),
          })).filter((bar: Candle) => Number.isFinite(bar.close))
        : [];
    }

    if (exchange === 'coinbase') {
      const { fetchTimeframe, aggregate } = chooseCoinbaseFetchTimeframe(timeframe);
      const granularity = timeframeToCoinbaseGranularity(fetchTimeframe);
      const seconds = TIMEFRAME_TO_MS[fetchTimeframe] / 1000;
      const end = Math.floor(Date.now() / 1000);
      const start = end - Math.max(1, limit) * seconds;
      const data = await fetchJson(`https://api.exchange.coinbase.com/products/${pair}/candles?granularity=${granularity}&start=${start}&end=${end}`);
      const rawBars = (Array.isArray(data) ? data : [])
        .map((row: unknown[]) => ({
          time: Number(row[0]) * 1000,
          low: Number(row[1]),
          high: Number(row[2]),
          open: Number(row[3]),
          close: Number(row[4]),
          volume: Number(row[5] ?? 0),
        }))
        .filter((bar) => Number.isFinite(bar.close))
        .sort((a, b) => a.time - b.time);
      return aggregate ? aggregateCandles(rawBars, aggregate).slice(-limit) : rawBars.slice(-limit);
    }

    if (exchange === 'gemini') {
      const symbol = normalizePair(pair, 'gemini');
      const { fetchTimeframe, aggregate } = chooseGeminiFetchTimeframe(timeframe);
      const interval = timeframeToGeminiInterval(fetchTimeframe);
      if (!interval) return [];
      // Gemini returns [time_ms, open, high, low, close, volume], newest-first.
      const data = await fetchJson(`https://api.gemini.com/v2/candles/${symbol}/${interval}`);
      const rawBars = (Array.isArray(data) ? data : [])
        .map((row: unknown[]) => ({
          time: Number(row[0]),
          open: Number(row[1]),
          high: Number(row[2]),
          low: Number(row[3]),
          close: Number(row[4]),
          volume: Number(row[5] ?? 0),
        }))
        .filter((bar) => Number.isFinite(bar.close))
        .sort((a, b) => a.time - b.time);
      return aggregate ? aggregateCandles(rawBars, aggregate).slice(-limit) : rawBars.slice(-limit);
    }
  } catch {
    return [];
  }
  return [];
}
