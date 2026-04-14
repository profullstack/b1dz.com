/**
 * Generic CEX adapter that wraps any `PriceFeed` from source-crypto-arb
 * into a `VenueAdapter` compatible with the v2 observer/daemon split.
 *
 * The existing PriceFeed.snapshot() gives bid/ask/sizes; we turn that
 * into a NormalizedQuote by pretending the top-of-book price is an
 * executable quote for the requested size. Slippage from depth drop-off
 * is modeled crudely until a proper book-walker lands — an MVP trade-off.
 */

import type { PriceFeed, MarketSnapshot } from '@b1dz/core';
import type { NormalizedQuote, QuoteRequest, VenueAdapter, AdapterHealth } from '@b1dz/venue-types';

/** Taker fee schedule from the live daemon — keeps backtest, observer,
 *  and daemon in sync. Don't inline per-exchange strings elsewhere. */
export const CEX_TAKER_FEES: Record<string, number> = {
  kraken: 0.0026,
  'binance-us': 0.001,
  coinbase: 0.006,
  gemini: 0.004,
};

export interface CexAdapterOptions {
  /** If the feed exposes a custom name, override it. Otherwise feed.exchange is used. */
  venueOverride?: string;
  /** Per-exchange taker fee. Falls back to CEX_TAKER_FEES. */
  feeRate?: number;
}

export class CexAdapter implements VenueAdapter {
  readonly venueType = 'cex' as const;
  readonly chain = null;
  readonly venue: string;
  private readonly feed: PriceFeed;
  private readonly feeRate: number;

  constructor(feed: PriceFeed, opts: CexAdapterOptions = {}) {
    this.feed = feed;
    this.venue = opts.venueOverride ?? feed.exchange;
    this.feeRate = opts.feeRate ?? CEX_TAKER_FEES[this.venue] ?? 0.005;
  }

  async health(): Promise<AdapterHealth> {
    const started = Date.now();
    try {
      // BTC-USD is listed on every supported CEX — the safest liveness probe.
      const snap = await this.feed.snapshot('BTC-USD');
      if (!snap) return { ok: false, reason: 'no BTC-USD snapshot' };
      return { ok: true, latencyMs: Date.now() - started };
    } catch (e) {
      return { ok: false, reason: (e as Error).message.slice(0, 200) };
    }
  }

  async supports(req: QuoteRequest): Promise<boolean> {
    // CEXs don't care about chain. Pair support is feed-specific — rather
    // than maintain a listing allowlist here, we'll let quote() return null
    // on missing pairs (snapshot() returns null when the symbol is unknown).
    if (req.chain && req.chain !== 'cex' && !req.chain.startsWith('cex:')) {
      // Chain constraint is asking for an onchain venue — not us.
      return false;
    }
    return true;
  }

  async quote(req: QuoteRequest): Promise<NormalizedQuote | null> {
    if (!(await this.supports(req))) return null;

    const started = Date.now();
    const snap = await this.feed.snapshot(req.pair);
    if (!snap) return null;
    const latencyMs = Date.now() - started;

    const [baseSymbol, quoteSymbol] = req.pair.split('-');
    const amountIn = Number.parseFloat(req.amountIn);
    if (!Number.isFinite(amountIn) || amountIn <= 0) return null;

    const { amountOut, unitPrice, slippageBps } = this.simulateFill(snap, req.side, amountIn);
    if (!Number.isFinite(amountOut) || amountOut <= 0) return null;

    // Fees charged on the executed notional in the QUOTE asset.
    // side=buy: notional = amountIn (already in quote); side=sell: notional = amountOut.
    const notionalQuote = req.side === 'buy' ? amountIn : amountOut;
    const feeUsd = notionalQuote * this.feeRate;

    return {
      venue: this.venue,
      venueType: 'cex',
      chain: null,
      dexProtocol: null,
      pair: req.pair,
      baseAsset: baseSymbol,
      quoteAsset: quoteSymbol,
      amountIn: req.amountIn,
      amountOut: amountOut.toString(),
      amountInUsd: null,
      amountOutUsd: null,
      side: req.side,
      estimatedUnitPrice: unitPrice.toString(),
      feeUsd,
      gasUsd: 0,
      slippageBps,
      priceImpactBps: slippageBps,
      routeHops: 1,
      routeSummary: [`${this.venue} top-of-book`],
      quoteTimestamp: snap.ts,
      expiresAt: null,
      latencyMs,
      allowanceRequired: false,
      approvalToken: null,
      tokenLifecycle: null,
      raw: snap,
    };
  }

  /**
   * Approximate a fill using top-of-book size. If the requested amount
   * exceeds top-of-book depth, we widen the effective price linearly
   * by a fallback slippage estimate — a placeholder until we have a
   * real book-walker.
   */
  private simulateFill(snap: MarketSnapshot, side: 'buy' | 'sell', amountIn: number): {
    amountOut: number;
    unitPrice: number;
    slippageBps: number;
  } {
    // side=buy: we spend quote (amountIn in USD-ish) at ask, receive base.
    // side=sell: we spend base (amountIn tokens), receive quote.
    if (side === 'buy') {
      const ask = snap.ask;
      const askSize = snap.askSize;
      const topDepthQuote = ask * askSize;
      let unitPrice = ask;
      let slippageBps = 0;
      if (topDepthQuote > 0 && amountIn > topDepthQuote) {
        const excessRatio = (amountIn - topDepthQuote) / topDepthQuote;
        // Every full top-of-book's worth of excess adds ~5 bps of slippage.
        slippageBps = Math.min(1000, Math.round(excessRatio * 5));
        unitPrice = ask * (1 + slippageBps / 10_000);
      }
      const amountOut = amountIn / unitPrice;
      return { amountOut, unitPrice: 1 / unitPrice, slippageBps };
    }
    const bid = snap.bid;
    const bidSize = snap.bidSize;
    let unitPrice = bid;
    let slippageBps = 0;
    if (bidSize > 0 && amountIn > bidSize) {
      const excessRatio = (amountIn - bidSize) / bidSize;
      slippageBps = Math.min(1000, Math.round(excessRatio * 5));
      unitPrice = bid * (1 - slippageBps / 10_000);
    }
    const amountOut = amountIn * unitPrice;
    return { amountOut, unitPrice, slippageBps };
  }
}
