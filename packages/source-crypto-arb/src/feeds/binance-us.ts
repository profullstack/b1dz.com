import type { PriceFeed, MarketSnapshot, OrderBook } from '@b1dz/core';
import { normalizePair } from './pairs.js';
import { fetchJson } from './http.js';
import { getSnapshot } from './ws-price-cache.js';

const BASE = 'https://api.binance.us';
const SYMBOL_CACHE_TTL_MS = 5 * 60_000;

let cachedSymbols: Set<string> | null = null;
let lastSymbolRefresh = 0;

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

interface BinanceExchangeInfo {
  symbols: { symbol: string; status: string }[];
}

async function getSupportedSymbols(): Promise<Set<string> | null> {
  if (cachedSymbols && (Date.now() - lastSymbolRefresh) < SYMBOL_CACHE_TTL_MS) {
    return cachedSymbols;
  }
  try {
    const info = await fetchJson<BinanceExchangeInfo>(`${BASE}/api/v3/exchangeInfo`);
    cachedSymbols = new Set(
      (info.symbols ?? [])
        .filter((s) => s?.status === 'TRADING' && !!s.symbol)
        .map((s) => s.symbol.toUpperCase()),
    );
    lastSymbolRefresh = Date.now();
    return cachedSymbols;
  } catch {
    return cachedSymbols;
  }
}

export class BinanceUsFeed implements PriceFeed {
  exchange = 'binance-us';

  async snapshot(pair: string): Promise<MarketSnapshot | null> {
    // Try WebSocket cache first
    const wsSnap = getSnapshot('binance-us', pair);
    if (wsSnap) return wsSnap;

    // Fallback to REST (through proxy)
    const symbol = normalizePair(pair, this.exchange);
    const supportedSymbols = await getSupportedSymbols();
    if (supportedSymbols && !supportedSymbols.has(symbol)) return null;
    try {
      const t = await fetchJson<BinanceBookTicker>(
        `${BASE}/api/v3/ticker/bookTicker?symbol=${symbol}`,
      );
      const bid = parseFloat(t.bidPrice);
      const ask = parseFloat(t.askPrice);
      const bidSize = parseFloat(t.bidQty);
      const askSize = parseFloat(t.askQty);
      if (!isFinite(bid) || !isFinite(ask) || bid <= 0 || ask <= 0) return null;
      return {
        exchange: this.exchange,
        pair,
        bid,
        ask,
        bidSize,
        askSize,
        ts: Date.now(),
      };
    } catch {
      return null;
    }
  }

  async orderBook(pair: string, depth = 10): Promise<OrderBook | null> {
    const symbol = normalizePair(pair, this.exchange);
    const supportedSymbols = await getSupportedSymbols();
    if (supportedSymbols && !supportedSymbols.has(symbol)) return null;
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
