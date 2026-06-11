/**
 * Market data primitives shared by exchange-style sources (crypto arb, FX,
 * stock arbitrage). Separated from `Source` because many strategies subscribe
 * to the same exchange feeds — one PriceFeed, many strategies on top.
 */

/**
 * Trading-session state for a symbol on its exchange. Crypto venues are always
 * 'open'; equity venues cycle pre/open/post/closed on an exchange calendar.
 * Lives here (not plugins.ts) because MarketSnapshot references it and plugins.ts
 * already imports from this module — keeping it here avoids an import cycle.
 * See docs/prd-equities-v1.md §5.
 */
export interface MarketSession {
  status: 'open' | 'closed' | 'pre' | 'post';
  /** Exchange-local next open/close, ISO 8601 with offset */
  nextOpen?: string;
  nextClose?: string;
  timezone: string; // e.g. 'America/New_York', 'Europe/London'
}

export interface MarketSnapshot {
  exchange: string;        // 'gemini' | 'kraken' | 'binance-us' | …
  pair: string;            // 'BTC-USD', 'ETH-USD', …
  bid: number;             // best bid
  ask: number;             // best ask
  bidSize: number;         // depth at best bid
  askSize: number;         // depth at best ask
  ts: number;              // ms epoch

  // --- Equity-aware optional fields (PRD equities-v1 §5). ---
  // Crypto paths leave these undefined; equity strategies and the risk engine
  // read them. Optional so all existing consumers compile unchanged.
  assetClass?: 'crypto' | 'equity';
  session?: MarketSession;
  currency?: string;       // 'USD', 'CAD', 'GBP', … (quote currency of `pair`)
  haltState?: 'none' | 'halted' | 'luld';
}

export interface OrderBookLevel { price: number; size: number; }
export interface OrderBook {
  exchange: string;
  pair: string;
  bids: OrderBookLevel[];  // descending by price
  asks: OrderBookLevel[];  // ascending by price
  ts: number;
}

/**
 * PriceFeed — pull-style interface a source can call to get the freshest
 * snapshot for one pair on one exchange. Implementations cache and may also
 * maintain a websocket subscription internally.
 */
export interface PriceFeed {
  exchange: string;
  snapshot(pair: string): Promise<MarketSnapshot | null>;
  orderBook?(pair: string, depth?: number): Promise<OrderBook | null>;
}

/** Walk an order book to compute the average fill price for a target size. */
export function avgFillPrice(levels: OrderBookLevel[], targetSize: number): number {
  let remaining = targetSize;
  let cost = 0;
  for (const l of levels) {
    const take = Math.min(remaining, l.size);
    cost += take * l.price;
    remaining -= take;
    if (remaining <= 0) break;
  }
  if (remaining > 0) return Number.POSITIVE_INFINITY; // not enough depth
  return cost / targetSize;
}
