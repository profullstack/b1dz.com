/**
 * Uniswap V3 (Base chain) price feed. Wraps the existing
 * UniswapV3Adapter's quoter-backed quote() to expose a ticker-shaped
 * bid/ask for Base-native pairs (WETH-USDC, cbBTC-USDC, etc.).
 *
 * Real bid/ask derived by quoting both directions for 1 unit of base:
 *   ask = USDC received when selling 1 base
 *   bid = USDC spent to receive 1 base (inverse of the buy side)
 *
 * No WebSocket — Base has ~2s blocks and the QuoterV2 contract call is
 * free over any HTTP RPC. We cache per-pair for CACHE_TTL_MS so the
 * scalping strategy's per-tick snapshots don't hammer the RPC.
 */

import type { PriceFeed, MarketSnapshot, OrderBook } from '@b1dz/core';

/** Minimal shape of UniswapV3Adapter.quote() we actually consume here —
 *  lets us avoid a package dep on @b1dz/venue-types just for the type. */
interface AdapterQuote {
  amountOut: string;
}

const CACHE_TTL_MS = 2_000;

interface CacheEntry { at: number; bid: number; ask: number }
const cache = new Map<string, CacheEntry>();

type Adapter = {
  venue: string;
  quote(req: { pair: string; side: 'buy' | 'sell'; amountIn: string; chain?: string }): Promise<AdapterQuote | null>;
};

/** Lazy adapter singleton. Lives on the first snapshot call so imports
 *  don't fail when BASE_RPC_URL isn't set at module-load time. */
let adapter: Adapter | null | undefined;
function getAdapter(): Adapter | null {
  if (adapter !== undefined) return adapter;
  if (!process.env.BASE_RPC_URL) { adapter = null; return null; }
  try {
    // Lazy require avoids pulling viem + adapters-evm into packages that
    // just import GeminiFeed / KrakenFeed / etc.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const evm = require('@b1dz/adapters-evm') as { UniswapV3Adapter: new (opts: { chain: string }) => Adapter };
    adapter = new evm.UniswapV3Adapter({ chain: 'base' });
    return adapter;
  } catch {
    adapter = null;
    return null;
  }
}

/** Canonical "BTC-USD" style pair names from the arb pair-discovery don't
 *  match what's actually listed on Base Uniswap. Map here so the feed
 *  works uniformly with the rest of the pipeline. */
const BASE_PAIR_MAP: Record<string, string> = {
  'BTC-USD': 'cbBTC-USDC',
  'BTC-USDC': 'cbBTC-USDC',
  'ETH-USD': 'WETH-USDC',
  'ETH-USDC': 'WETH-USDC',
  'WETH-USD': 'WETH-USDC',
  'cbBTC-USD': 'cbBTC-USDC',
};

export class UniswapBaseFeed implements PriceFeed {
  exchange = 'uniswap-v3';

  async snapshot(pair: string): Promise<MarketSnapshot | null> {
    const mappedPair = BASE_PAIR_MAP[pair] ?? pair;
    // If the pair doesn't map AND the request quote isn't USDC, skip —
    // Uniswap V3 Base quotes in USDC not USD, so USD-denominated pairs
    // that aren't in the map can't be served here.
    if (!BASE_PAIR_MAP[pair] && !mappedPair.endsWith('-USDC')) return null;

    const cached = cache.get(mappedPair);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
      return { exchange: this.exchange, pair, bid: cached.bid, ask: cached.ask, bidSize: 0, askSize: 0, ts: cached.at };
    }
    const a = getAdapter();
    if (!a) return null;

    try {
      // Ask leg: sell 1 base → USDC out.
      const ask = await a.quote({ pair: mappedPair, side: 'sell', amountIn: '1', chain: 'base' });
      // Bid leg: spend 1 USDC → get base. Price = 1 / amountOut.
      const buy = await a.quote({ pair: mappedPair, side: 'buy', amountIn: '1', chain: 'base' });
      if (!ask || !buy) return null;

      const askPrice = parseFloat(ask.amountOut);
      const bidBaseOut = parseFloat(buy.amountOut);
      if (!(askPrice > 0) || !(bidBaseOut > 0)) return null;
      const bidPrice = 1 / bidBaseOut;

      const entry = { at: Date.now(), bid: bidPrice, ask: askPrice };
      cache.set(mappedPair, entry);
      return { exchange: this.exchange, pair, bid: bidPrice, ask: askPrice, bidSize: 0, askSize: 0, ts: entry.at };
    } catch {
      return null;
    }
  }

  async orderBook(_pair: string, _depth = 10): Promise<OrderBook | null> {
    // AMMs have no book — use the quoter per-size instead.
    return null;
  }
}
