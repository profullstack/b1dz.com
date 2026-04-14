/**
 * Profitability engine for v2: take a bag of NormalizedQuotes from
 * different venues and rank actionable cross-venue opportunities by
 * expected net P&L.
 *
 * Strict interpretation of PRD §19:
 *   expectedNetUsd = exitValue - entryValue - fees - gas - slippage -
 *                    approvalCost - transferCost - priorityFee - riskBuffer
 *
 * We don't model transferCost yet (capital is pre-parked per venue) or
 * priorityFee (Solana only, folded into gasUsd). Approval cost is folded
 * into gasUsd by the EVM adapters when an allowance is required.
 */

import type {
  NormalizedQuote,
  Opportunity,
  OpportunityCategory,
} from '@b1dz/venue-types';

export interface RankerConfig {
  /** Trade notional in USD used to size the comparison. */
  tradeSizeUsd: number;
  /** Additional safety buffer subtracted from net (§19 riskBuffer). */
  riskBufferUsd?: number;
  /** Minimum net USD edge to consider an opportunity executable. */
  minNetUsd?: number;
  /** Minimum net bps to consider executable (guards against big trades
   *  with thin relative edge). */
  minNetBps?: number;
  /** Optional per-pair price-oracle function used to translate quote-asset
   *  amounts into USD. Falls back to treating stablecoin quote assets as
   *  1:1 USD. */
  priceUsd?: (asset: string) => number | null;
}

const STABLECOINS = new Set(['USD', 'USDC', 'USDT', 'DAI', 'USDbC', 'DAI.e', 'FDUSD', 'PYUSD']);

function unitUsd(asset: string, priceUsd?: (asset: string) => number | null): number {
  if (STABLECOINS.has(asset.toUpperCase())) return 1;
  const px = priceUsd?.(asset.toUpperCase());
  return Number.isFinite(px) && px! > 0 ? px! : 0;
}

function categorizeRoute(buy: NormalizedQuote, sell: NormalizedQuote): OpportunityCategory {
  if (buy.venueType === 'cex' && sell.venueType === 'cex') return 'cex_cex';
  if (buy.venueType === 'cex' || sell.venueType === 'cex') return 'cex_dex';
  return 'dex_dex';
}

function routeKey(buy: NormalizedQuote, sell: NormalizedQuote): string {
  return `${buy.venue}->${sell.venue}:${buy.pair}`;
}

/**
 * Given a pool of quotes covering both sides of a round trip (buy and
 * sell legs on the same base asset), enumerate every pairwise
 * (buy-venue, sell-venue) combination and score it.
 *
 * buyQuotes must have side='buy' (spend quote → acquire base).
 * sellQuotes must have side='sell' (spend base → receive quote).
 * All quotes must share the same baseAsset for the ranking to make sense.
 */
export function rankCrossVenueOpportunities(
  buyQuotes: NormalizedQuote[],
  sellQuotes: NormalizedQuote[],
  cfg: RankerConfig,
): Opportunity[] {
  const out: Opportunity[] = [];
  const tradeSize = cfg.tradeSizeUsd;
  const riskBuffer = cfg.riskBufferUsd ?? 0;
  const minNetUsd = cfg.minNetUsd ?? 0;
  const minNetBps = cfg.minNetBps ?? 0;

  for (const buy of buyQuotes) {
    if (buy.side !== 'buy') continue;
    for (const sell of sellQuotes) {
      if (sell.side !== 'sell') continue;
      if (buy.baseAsset !== sell.baseAsset) continue;
      if (buy.venue === sell.venue) continue;

      // How much base asset we acquire on the buy leg.
      const baseAcquired = Number.parseFloat(buy.amountOut);
      if (!Number.isFinite(baseAcquired) || baseAcquired <= 0) continue;

      // How much quote-asset we get back if we sell that exact base amount.
      // We scale the sell quote linearly (its amountIn/amountOut ratio) to
      // the base amount we actually hold. Linear scaling is an approximation
      // — real fills degrade with size, but each quote already includes
      // slippage/priceImpact at its original size, so for the MVP ranker
      // this is good enough.
      const sellBaseIn = Number.parseFloat(sell.amountIn);
      const sellQuoteOut = Number.parseFloat(sell.amountOut);
      if (!Number.isFinite(sellBaseIn) || sellBaseIn <= 0) continue;
      if (!Number.isFinite(sellQuoteOut) || sellQuoteOut <= 0) continue;
      const scaledQuoteOut = (sellQuoteOut / sellBaseIn) * baseAcquired;

      const quoteAssetUsd = unitUsd(sell.quoteAsset, cfg.priceUsd);
      const buyQuoteAssetUsd = unitUsd(buy.quoteAsset, cfg.priceUsd);
      if (quoteAssetUsd === 0 || buyQuoteAssetUsd === 0) continue;

      // Entry + exit USD values.
      const entryValueUsd = Number.parseFloat(buy.amountIn) * buyQuoteAssetUsd;
      const exitValueUsd = scaledQuoteOut * quoteAssetUsd;

      const grossEdgeUsd = exitValueUsd - entryValueUsd;
      const totalFeesUsd = buy.feeUsd + sell.feeUsd;
      const totalGasUsd = buy.gasUsd + sell.gasUsd;
      const totalSlippageUsd = ((buy.slippageBps + sell.slippageBps) / 10_000) * tradeSize;
      const expectedNetUsd =
        grossEdgeUsd - totalFeesUsd - totalGasUsd - totalSlippageUsd - riskBuffer;
      const expectedNetBps = tradeSize > 0 ? (expectedNetUsd / tradeSize) * 10_000 : 0;

      const blockers: string[] = [];
      if (grossEdgeUsd <= 0) blockers.push('negative gross edge');
      if (expectedNetUsd <= minNetUsd) blockers.push(`net ${expectedNetUsd.toFixed(4)} <= min ${minNetUsd}`);
      if (expectedNetBps < minNetBps) blockers.push(`bps ${expectedNetBps.toFixed(1)} < min ${minNetBps}`);

      // Quote staleness: if the oldest quote is > 15 seconds old, mark it.
      const age = Date.now() - Math.min(buy.quoteTimestamp, sell.quoteTimestamp);
      if (age > 15_000) blockers.push(`stale quote ${Math.round(age / 1000)}s`);

      out.push({
        id: routeKey(buy, sell),
        buyVenue: buy.venue,
        sellVenue: sell.venue,
        buyChain: buy.chain,
        sellChain: sell.chain,
        asset: buy.baseAsset,
        size: tradeSize.toString(),
        grossEdgeUsd,
        totalFeesUsd,
        totalGasUsd,
        totalSlippageUsd,
        riskBufferUsd: riskBuffer,
        expectedNetUsd,
        expectedNetBps,
        confidence: Math.min(1, Math.max(0, expectedNetBps / 100)),
        blockers,
        executable: blockers.length === 0,
        category: categorizeRoute(buy, sell),
        buyQuote: buy,
        sellQuote: sell,
        observedAt: Date.now(),
      });
    }
  }

  out.sort((a, b) => b.expectedNetUsd - a.expectedNetUsd);
  return out;
}
