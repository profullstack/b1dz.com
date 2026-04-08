/**
 * Exchange feed stubs. Each implements PriceFeed against a real REST/WS API.
 * Stage 1: stubbed — return null and let the source decide what to do.
 * Stage 2: implement Gemini, Kraken, Binance.US public ticker + order book.
 */

import type { PriceFeed, MarketSnapshot, OrderBook } from '@b1dz/core';

abstract class StubFeed implements PriceFeed {
  abstract exchange: string;
  async snapshot(_pair: string): Promise<MarketSnapshot | null> {
    // TODO: hit the public ticker endpoint
    return null;
  }
  async orderBook(_pair: string, _depth = 10): Promise<OrderBook | null> {
    // TODO: hit the public order book endpoint
    return null;
  }
}

export class GeminiFeed extends StubFeed { exchange = 'gemini'; }
export class KrakenFeed extends StubFeed { exchange = 'kraken'; }
export class BinanceUsFeed extends StubFeed { exchange = 'binance-us'; }
