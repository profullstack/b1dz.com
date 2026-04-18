// @ts-nocheck
import { retainWsSubscription, getWsSnapshot, normalizePair } from '@b1dz/source-crypto-arb';
import { aggregateBars, TIMEFRAME_TO_MS } from './timeframeAggregator.js';

const COINBASE_GRANULARITY = {
  '1m': 'ONE_MINUTE',
  '5m': 'FIVE_MINUTE',
  '15m': 'FIFTEEN_MINUTE',
  '1h': 'ONE_HOUR',
  '1d': 'ONE_DAY',
};

function timeframeToKrakenInterval(timeframe) {
  return {
    '1m': 1,
    '5m': 5,
    '15m': 15,
    '1h': 60,
    '4h': 240,
    '1d': 1440,
    '1w': 10080,
  }[timeframe] ?? 1;
}

function timeframeToBinanceInterval(timeframe) {
  return {
    '1m': '1m',
    '5m': '5m',
    '15m': '15m',
    '1h': '1h',
    '4h': '4h',
    '1d': '1d',
    '1w': '1w',
  }[timeframe] ?? '1m';
}

function timeframeToCoinbaseExchangeGranularity(timeframe) {
  return {
    '1m': 60,
    '5m': 300,
    '15m': 900,
    '1h': 3600,
    '4h': 14400,
    '1d': 86400,
    '1w': 86400,
  }[timeframe] ?? 60;
}

function chooseCoinbaseFetchTimeframe(timeframe) {
  if (timeframe === '4h') return { fetchTimeframe: '1h', aggregate: '4h' };
  if (timeframe === '1w') return { fetchTimeframe: '1d', aggregate: '1w' };
  return { fetchTimeframe: timeframe, aggregate: null };
}

function timeframeToGeminiInterval(timeframe) {
  return {
    '1m': '1m',
    '5m': '5m',
    '15m': '15m',
    '1h': '1hr',
    '6h': '6hr',
    '1d': '1day',
  }[timeframe] ?? '1m';
}

function chooseGeminiFetchTimeframe(timeframe) {
  if (timeframe === '4h') return { fetchTimeframe: '1h', aggregate: '4h' };
  if (timeframe === '1w') return { fetchTimeframe: '1d', aggregate: '1w' };
  return { fetchTimeframe: timeframe, aggregate: null };
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${res.status} ${text.slice(0, 160)}`.trim());
  }
  return res.json();
}

export async function fetchHistoricalBars({ pair, exchange, timeframe, limit = 120 }) {
  try {
    if (exchange === 'kraken') {
      const interval = timeframeToKrakenInterval(timeframe);
      const symbol = normalizePair(pair, 'kraken');
      const data = await fetchJson(`https://api.kraken.com/0/public/OHLC?pair=${encodeURIComponent(symbol)}&interval=${interval}`);
      const series = Array.isArray(data?.result?.[symbol])
        ? data.result[symbol]
        : Array.isArray(data?.result?.[Object.keys(data?.result ?? {}).find((key) => key !== 'last') ?? ''])
          ? data.result[Object.keys(data.result).find((key) => key !== 'last')]
          : [];
      return series
        .map((row) => ({
          time: Number(row[0]) * 1000,
          open: Number(row[1]),
          high: Number(row[2]),
          low: Number(row[3]),
          close: Number(row[4]),
          volume: Number(row[6] ?? 0),
        }))
        .filter((bar) => Number.isFinite(bar.close))
        .slice(-limit);
    }

    if (exchange === 'binance-us') {
      const interval = timeframeToBinanceInterval(timeframe);
      const symbol = normalizePair(pair, 'binance-us');
      const data = await fetchJson(`https://api.binance.us/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${Math.min(limit, 500)}`);
      return Array.isArray(data)
        ? data.map((row) => ({
            time: Number(row[0]),
            open: Number(row[1]),
            high: Number(row[2]),
            low: Number(row[3]),
            close: Number(row[4]),
            volume: Number(row[5]),
          })).filter((bar) => Number.isFinite(bar.close))
        : [];
    }

    if (exchange === 'coinbase') {
      const { fetchTimeframe, aggregate } = chooseCoinbaseFetchTimeframe(timeframe);
      const granularity = timeframeToCoinbaseExchangeGranularity(fetchTimeframe);
      const seconds = TIMEFRAME_TO_MS[fetchTimeframe] / 1000;
      const end = Math.floor(Date.now() / 1000);
      const start = end - Math.max(1, limit) * seconds;
      const data = await fetchJson(
        `https://api.exchange.coinbase.com/products/${pair}/candles?granularity=${granularity}&start=${start}&end=${end}`,
      );
      const rawBars = (Array.isArray(data) ? data : [])
        .map((row) => ({
          time: Number(row[0]) * 1000,
          low: Number(row[1]),
          high: Number(row[2]),
          open: Number(row[3]),
          close: Number(row[4]),
          volume: Number(row[5] ?? 0),
        }))
        .filter((bar) => Number.isFinite(bar.close))
        .sort((a, b) => a.time - b.time);
      return aggregate ? aggregateBars(rawBars, aggregate).slice(-limit) : rawBars.slice(-limit);
    }

    if (exchange === 'gemini') {
      const { fetchTimeframe, aggregate } = chooseGeminiFetchTimeframe(timeframe);
      const interval = timeframeToGeminiInterval(fetchTimeframe);
      const symbol = normalizePair(pair, 'gemini');
      // Gemini returns [time_ms, open, high, low, close, volume], newest-first.
      const data = await fetchJson(`https://api.gemini.com/v2/candles/${symbol}/${interval}`);
      const rawBars = (Array.isArray(data) ? data : [])
        .map((row) => ({
          time: Number(row[0]),
          open: Number(row[1]),
          high: Number(row[2]),
          low: Number(row[3]),
          close: Number(row[4]),
          volume: Number(row[5] ?? 0),
        }))
        .filter((bar) => Number.isFinite(bar.close))
        .sort((a, b) => a.time - b.time);
      return aggregate ? aggregateBars(rawBars, aggregate).slice(-limit) : rawBars.slice(-limit);
    }

    // DEX venues: no native OHLC endpoint, so we can't backfill history.
    // Return an empty history and rely on createLiveFeed to synthesize
    // bars tick-by-tick from snapshot prices (already handled by the
    // ws-cache path below).
    if (exchange === 'uniswap-v3' || exchange === 'jupiter') {
      return [];
    }
  } catch (error) {
    return [];
  }
  return [];
}

export function createLiveFeed({ pair, exchange, onTick, onStatus, pollMs = 250, staleAfterMs = 15_000 }) {
  const release = retainWsSubscription([pair]);
  let stopped = false;
  let lastSeen = 0;
  let lastPublishedTs = 0;
  let lastPublishedPrice = null;

  const emitStatus = (status) => {
    if (!stopped) onStatus?.(status);
  };

  const publishSnapshot = (snap) => {
    if (!snap) return false;
    const bid = Number(snap?.bid);
    const ask = Number(snap?.ask);
    const bidSize = Number(snap?.bidSize);
    const askSize = Number(snap?.askSize);
    const price = Number.isFinite(bid) && bid > 0 && Number.isFinite(ask) && ask > 0
      ? (bid + ask) / 2
      : Number.isFinite(bid) && bid > 0
        ? bid
        : ask;
    const volume = Math.max(
      Number.isFinite(bidSize) && bidSize > 0 ? bidSize : 0,
      Number.isFinite(askSize) && askSize > 0 ? askSize : 0,
    );
    if (!(snap?.ts && Number.isFinite(price))) return false;
    if (!(snap.ts > lastPublishedTs || price !== lastPublishedPrice)) return false;
    lastPublishedTs = snap.ts;
    lastPublishedPrice = price;
    lastSeen = Date.now();
    emitStatus('live');
    onTick?.({
      time: snap.ts,
      price,
      volume,
      exchange,
      pair,
    });
    return true;
  };

  emitStatus('reconnecting');

  const timer = setInterval(() => {
    if (stopped) return;
    const snap = getWsSnapshot(exchange, pair);
    if (publishSnapshot(snap)) {
      return;
    }
    if (!lastSeen) {
      emitStatus('reconnecting');
      return;
    }
    if (Date.now() - lastSeen > staleAfterMs) {
      emitStatus('stale');
    }
  }, pollMs);

  return () => {
    stopped = true;
    clearInterval(timer);
    release();
  };
}
