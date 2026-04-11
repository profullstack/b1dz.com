import type { PriceFeed, MarketSnapshot, OrderBook } from '@b1dz/core';
import { normalizePair } from './pairs.js';
import { fetchJson } from './http.js';

const BASE = 'https://api.binance.us';

interface BinanceBookTicker {
  bidPrice: string;
  bidQty: string;
  askPrice: string;
  askQty: string;
}

interface BinanceDepth {
  bids: [string, string][];
  asks: [string, string][];
}

export class BinanceUsFeed implements PriceFeed {
  exchange = 'binance-us';

  async snapshot(pair: string): Promise<MarketSnapshot | null> {
    const symbol = normalizePair(pair, this.exchange);
    try {
      const t = await fetchJson<BinanceBookTicker>(
        `${BASE}/api/v3/ticker/bookTicker?symbol=${symbol}`,
      );
      return {
        exchange: this.exchange,
        pair,
        bid: parseFloat(t.bidPrice),
        ask: parseFloat(t.askPrice),
        bidSize: parseFloat(t.bidQty),
        askSize: parseFloat(t.askQty),
        ts: Date.now(),
      };
    } catch {
      return null;
    }
  }

  async orderBook(pair: string, depth = 10): Promise<OrderBook | null> {
    const symbol = normalizePair(pair, this.exchange);
    try {
      const book = await fetchJson<BinanceDepth>(
        `${BASE}/api/v3/depth?symbol=${symbol}&limit=${depth}`,
      );
      return {
        exchange: this.exchange,
        pair,
        bids: book.bids.map(([price, size]) => ({ price: parseFloat(price), size: parseFloat(size) })),
        asks: book.asks.map(([price, size]) => ({ price: parseFloat(price), size: parseFloat(size) })),
        ts: Date.now(),
      };
    } catch {
      return null;
    }
  }
}
