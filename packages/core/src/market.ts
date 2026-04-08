/**
 * Market data primitives shared by exchange-style sources (crypto arb, FX,
 * stock arbitrage). Separated from `Source` because many strategies subscribe
 * to the same exchange feeds — one PriceFeed, many strategies on top.
 */

export interface MarketSnapshot {
  exchange: string;        // 'gemini' | 'kraken' | 'binance-us' | …
  pair: string;            // 'BTC-USD', 'ETH-USD', …
  bid: number;             // best bid
  ask: number;             // best ask
  bidSize: number;         // depth at best bid
  askSize: number;         // depth at best ask
  ts: number;              // ms epoch
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
