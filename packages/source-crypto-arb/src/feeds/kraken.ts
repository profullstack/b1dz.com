import type { PriceFeed, MarketSnapshot, OrderBook } from '@b1dz/core';
import { normalizePair } from './pairs.js';
import { fetchJson } from './http.js';
import { getSnapshot } from './ws-price-cache.js';

const BASE = 'https://api.kraken.com';

interface KrakenTickerEntry {
  b: [string, string, string];
  a: [string, string, string];
}

interface KrakenDepthResponse {
  error: string[];
  result: Record<string, {
    bids: [string, string, number][];
    asks: [string, string, number][];
  }>;
}

export class KrakenFeed implements PriceFeed {
  exchange = 'kraken';

  async snapshot(pair: string): Promise<MarketSnapshot | null> {
    // Try WebSocket cache first (instant, no HTTP)
    const cached = getSnapshot('kraken', pair);
    if (cached) return cached;

    // Fallback to REST (during warmup or if WS disconnected)
    const symbol = normalizePair(pair, this.exchange);
    try {
      const data = await fetchJson<{ error: string[]; result: Record<string, KrakenTickerEntry> }>(
        `${BASE}/0/public/Ticker?pair=${symbol}`,
      );
      if (data.error?.length) return null;
      const entry = Object.values(data.result)[0];
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
