import type { PriceFeed, MarketSnapshot, OrderBook } from '@b1dz/core';
import { normalizePair } from './pairs.js';
import { fetchJson } from './http.js';

const BASE = 'https://api.kraken.com';

interface KrakenTickerEntry {
  b: [string, string, string];
  a: [string, string, string];
}

interface KrakenTickerResponse {
  error: string[];
  result: Record<string, KrakenTickerEntry>;
}

interface KrakenDepthResponse {
  error: string[];
  result: Record<string, {
    bids: [string, string, number][];
    asks: [string, string, number][];
  }>;
}

// Batch ticker cache — fetched once, used by all snapshot() calls within the same tick
let batchCache: Map<string, KrakenTickerEntry> = new Map();
let batchCacheTs = 0;
const BATCH_TTL = 1500; // 1.5s — fresh enough for trading

async function ensureBatchCache(): Promise<Map<string, KrakenTickerEntry>> {
  if (Date.now() - batchCacheTs < BATCH_TTL && batchCache.size > 0) return batchCache;
  try {
    const data = await fetchJson<KrakenTickerResponse>(`${BASE}/0/public/Ticker`);
    if (!data.error?.length && data.result) {
      batchCache = new Map(Object.entries(data.result));
      batchCacheTs = Date.now();
    }
  } catch {}
  return batchCache;
}

export class KrakenFeed implements PriceFeed {
  exchange = 'kraken';

  async snapshot(pair: string): Promise<MarketSnapshot | null> {
    const symbol = normalizePair(pair, this.exchange);
    try {
      const cache = await ensureBatchCache();
      // Kraken keys can be the symbol or have X/Z prefixes
      const entry = cache.get(symbol)
        ?? cache.get(`X${symbol}`)
        ?? cache.get(`${symbol}ZUSD`.replace('USDZUSD', 'ZUSD'))
        ?? [...cache.entries()].find(([k]) => k.includes(symbol))?.[1];
      if (!entry) return null;
      return {
        exchange: this.exchange,
        pair,
        bid: parseFloat(entry.b[0]),
        ask: parseFloat(entry.a[0]),
        bidSize: parseFloat(entry.b[2]),
        askSize: parseFloat(entry.a[2]),
        ts: Date.now(),
      };
    } catch {
      return null;
    }
  }

  async orderBook(pair: string, depth = 10): Promise<OrderBook | null> {
    const symbol = normalizePair(pair, this.exchange);
    try {
      const data = await fetchJson<KrakenDepthResponse>(
        `${BASE}/0/public/Depth?pair=${symbol}&count=${depth}`,
      );
      if (data.error?.length) return null;
      const entry = Object.values(data.result)[0];
      if (!entry) return null;
      return {
        exchange: this.exchange,
        pair,
        bids: entry.bids.map(([price, size]) => ({ price: parseFloat(price), size: parseFloat(size) })),
        asks: entry.asks.map(([price, size]) => ({ price: parseFloat(price), size: parseFloat(size) })),
        ts: Date.now(),
      };
    } catch {
      return null;
    }
  }
}
