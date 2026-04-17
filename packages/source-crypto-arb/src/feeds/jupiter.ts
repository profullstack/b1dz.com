/**
 * Jupiter (Solana) price feed. Reads from the public pricing API which
 * aggregates across Raydium, Orca, Whirlpool, Meteora, etc. Quotes are
 * USD-per-token so we present them as a bid/ask with a symmetric 0.1%
 * spread (a reasonable proxy — Jupiter routes already bake in some
 * slippage estimate).
 *
 * Endpoint: https://api.jup.ag/price/v2?ids=TOKEN1,TOKEN2
 * Free, no auth. Latency ~200ms, typical cache ~1s.
 *
 * The PriceFeed.snapshot() signature is per-pair; we let callers batch
 * by pair but the underlying HTTP call covers many tokens per request
 * if we see multiple pairs within CACHE_TTL_MS. Coarse but cheap.
 */

import type { PriceFeed, MarketSnapshot, OrderBook } from '@b1dz/core';

const BASE = 'https://api.jup.ag/price/v2';
const CACHE_TTL_MS = 1_500;

/** USD-per-token response from Jupiter's pricing API. */
interface JupiterPriceResponse {
  data: Record<string, { id: string; type: string; price: string } | null>;
}

let cache: { at: number; prices: Map<string, number> } | null = null;
let inFlight: Promise<Map<string, number>> | null = null;

/** Reset the in-memory cache. Test-only — module-level state would
 *  otherwise bleed across vitest test cases. */
export function __resetJupiterCacheForTests(): void {
  cache = null;
  inFlight = null;
}

/** Tokens we ship with — mostly Solana-native that the arb observer has
 *  meaningful depth for. Callers can pass additional tokens via snapshot(). */
const DEFAULT_TOKENS = ['SOL', 'BONK', 'WIF', 'JUP', 'RAY', 'USDC', 'USDT'];

async function fetchPrices(tokens: string[]): Promise<Map<string, number>> {
  if (inFlight) return inFlight;
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.prices;

  inFlight = (async () => {
    const ids = [...new Set([...DEFAULT_TOKENS, ...tokens])].join(',');
    try {
      const res = await fetch(`${BASE}?ids=${ids}`, { signal: AbortSignal.timeout(3000) });
      if (!res.ok) return cache?.prices ?? new Map<string, number>();
      const body = (await res.json()) as JupiterPriceResponse;
      const out = new Map<string, number>();
      for (const [sym, entry] of Object.entries(body.data ?? {})) {
        if (!entry || !entry.price) continue;
        const n = Number.parseFloat(entry.price);
        if (Number.isFinite(n) && n > 0) out.set(sym.toUpperCase(), n);
      }
      cache = { at: Date.now(), prices: out };
      return out;
    } catch {
      return cache?.prices ?? new Map<string, number>();
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

export class JupiterFeed implements PriceFeed {
  exchange = 'jupiter';

  async snapshot(pair: string): Promise<MarketSnapshot | null> {
    const [base] = pair.split('-');
    if (!base) return null;
    const prices = await fetchPrices([base.toUpperCase()]);
    const price = prices.get(base.toUpperCase());
    if (!(price && price > 0)) return null;
    // Jupiter gives mid; synthesize a 10-bps spread bid/ask so the
    // downstream consumers see the same shape as CEX ticker feeds.
    const spread = price * 0.0005;
    return {
      exchange: this.exchange,
      pair,
      bid: price - spread,
      ask: price + spread,
      bidSize: 0,
      askSize: 0,
      ts: Date.now(),
    };
  }

  async orderBook(_pair: string, _depth = 10): Promise<OrderBook | null> {
    // Jupiter doesn't publish a book — it's a router. Return null so the
    // arb observer knows to skip book-depth checks on this venue.
    return null;
  }
}
