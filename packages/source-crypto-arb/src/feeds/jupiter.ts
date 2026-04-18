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

const BASE = 'https://lite-api.jup.ag/price/v3';
const CACHE_TTL_MS = 1_500;

/** Symbol → Solana mint address. Jupiter v3 keys by mint. */
const SYMBOL_TO_MINT: Record<string, string> = {
  SOL:   'So11111111111111111111111111111111111111112',
  USDC:  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  USDT:  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
  BONK:  'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
  WIF:   'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm',
  JUP:   'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
  RAY:   '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R',
  ORCA:  'orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE',
  JTO:   'jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL',
  PYTH:  'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3',
};
const MINT_TO_SYMBOL = Object.fromEntries(Object.entries(SYMBOL_TO_MINT).map(([s, m]) => [m, s]));

/** Jupiter v3 response: keyed by mint address. */
interface JupiterV3Price {
  usdPrice: number;
  priceChange24h?: number;
  liquidity?: number;
  blockId?: number;
  decimals?: number;
}
type JupiterV3Response = Record<string, JupiterV3Price | null>;

let cache: { at: number; prices: Map<string, number> } | null = null;
let inFlight: Promise<Map<string, number>> | null = null;

/** Reset the in-memory cache. Test-only — module-level state would
 *  otherwise bleed across vitest test cases. */
export function __resetJupiterCacheForTests(): void {
  cache = null;
  inFlight = null;
}

/** Tokens we ship with — the ones the price-v3 API knows about and that
 *  have meaningful Solana DEX depth. Callers can pass more via snapshot()
 *  but unmapped symbols are silently skipped (no mint lookup available). */
const DEFAULT_TOKENS = ['SOL', 'BONK', 'WIF', 'JUP', 'RAY', 'USDC', 'USDT', 'JTO', 'PYTH', 'ORCA'];

async function fetchPrices(tokens: string[]): Promise<Map<string, number>> {
  if (inFlight) return inFlight;
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.prices;

  inFlight = (async () => {
    const wanted = [...new Set([...DEFAULT_TOKENS, ...tokens.map((t) => t.toUpperCase())])];
    const mints = wanted.map((s) => SYMBOL_TO_MINT[s]).filter(Boolean);
    if (mints.length === 0) {
      return cache?.prices ?? new Map<string, number>();
    }
    try {
      const res = await fetch(`${BASE}?ids=${mints.join(',')}`, { signal: AbortSignal.timeout(3000) });
      if (!res.ok) return cache?.prices ?? new Map<string, number>();
      const body = (await res.json()) as JupiterV3Response;
      const out = new Map<string, number>();
      for (const [mint, entry] of Object.entries(body ?? {})) {
        const sym = MINT_TO_SYMBOL[mint];
        if (!sym || !entry || typeof entry.usdPrice !== 'number') continue;
        if (!Number.isFinite(entry.usdPrice) || entry.usdPrice <= 0) continue;
        out.set(sym, entry.usdPrice);
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
