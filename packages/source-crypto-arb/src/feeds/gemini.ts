import type { PriceFeed, MarketSnapshot, OrderBook } from '@b1dz/core';
import { normalizePair } from './pairs.js';
import { fetchJson } from './http.js';
import { getSnapshot } from './ws-price-cache.js';

const BASE = 'https://api.gemini.com';

interface GeminiTicker {
  bid: string;
  ask: string;
  last: string;
  volume: { [key: string]: string };
}

interface GeminiBookEntry {
  price: string;
  amount: string;
}

interface GeminiBook {
  bids: GeminiBookEntry[];
  asks: GeminiBookEntry[];
}

export class GeminiFeed implements PriceFeed {
  exchange = 'gemini';

  async snapshot(pair: string): Promise<MarketSnapshot | null> {
    // Try WebSocket cache first. Without this, every poll for Gemini
    // hits REST at /v1/pubticker — which (a) burns the public-API rate
    // budget, (b) returns a snapshot 1–3s behind market, and (c) on a
    // multi-pair scanner means dozens of HTTP calls/sec when we already
    // have a streaming feed populating the cache.
    const cached = getSnapshot('gemini', pair);
    if (cached) return cached;

    const symbol = normalizePair(pair, this.exchange);
    try {
      const t = await fetchJson<GeminiTicker>(`${BASE}/v1/pubticker/${symbol}`);
      return {
        exchange: this.exchange,
        pair,
        bid: parseFloat(t.bid),
        ask: parseFloat(t.ask),
        bidSize: 0,
        askSize: 0,
        ts: Date.now(),
      };
    } catch {
      return null;
    }
  }

  async orderBook(pair: string, depth = 10): Promise<OrderBook | null> {
    const symbol = normalizePair(pair, this.exchange);
    try {
      const book = await fetchJson<GeminiBook>(
        `${BASE}/v1/book/${symbol}?limit_bids=${depth}&limit_asks=${depth}`,
      );
      return {
        exchange: this.exchange,
        pair,
        bids: book.bids.map((e) => ({ price: parseFloat(e.price), size: parseFloat(e.amount) })),
        asks: book.asks.map((e) => ({ price: parseFloat(e.price), size: parseFloat(e.amount) })),
        ts: Date.now(),
      };
    } catch {
      return null;
    }
  }
}
