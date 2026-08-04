/**
 * Trading cost model for the backtester.
 *
 * A backtest that prices fills at the mid and charges no fee is not a
 * conservative estimate — it is a different, easier game. Three frictions,
 * every one of which is paid on every round trip:
 *
 *   1. SPREAD      you buy at the ask and sell at the bid, never at the mid.
 *                  Using mid for both legs understates cost by the full spread.
 *   2. FEE         taker fee on notional, charged on BOTH legs. Coinbase's 60 bps
 *                  round trip is 120 bps — larger than the entire edge of most
 *                  short-horizon strategies.
 *   3. SLIPPAGE    market impact beyond the quoted top of book.
 *
 * Why spread has to be *modelled* and not just read: most historical series
 * available to us are daily closes, which get turned into snapshots with
 * `bid === ask === close` (see apps/web/src/lib/strategy-backtest-runner.ts).
 * Those snapshots have a literal zero spread. So when a snapshot carries no real
 * two-sided quote we apply `assumedHalfSpreadBps`; when it carries a genuine
 * bid/ask (live tick data, forward tests) we use the real thing.
 *
 * All rates are basis points of notional. 1 bp = 0.01%.
 */
import {
  cexTakerFee,
  toBps,
  DEFAULT_DEX_POOL_FEE,
  DEFAULT_DEX_GAS_USD,
  DEFAULT_EQUITY_COMMISSION,
  type MarketSnapshot,
} from '@b1dz/core';

export interface CostModel {
  /** Taker fee in bps of notional, charged on entry AND exit. */
  feeBps: number;
  /** One-way market impact in bps, applied against the executing side each leg. */
  slippageBps: number;
  /**
   * Half-spread in bps, used ONLY when a snapshot has no real two-sided quote
   * (bid === ask). Entry pays +half, exit pays −half, so a round trip costs the
   * full spread — which is the correct treatment.
   */
  assumedHalfSpreadBps: number;
  /** Flat cost per order in quote currency (DEX gas, per-contract fees). */
  perOrderUsd: number;
}

/**
 * No friction at all. Exists so state-machine tests can isolate the replay
 * logic, and so the UI can show a gross-vs-net comparison. Never use this to
 * evaluate whether a strategy is worth trading or selling.
 */
export const ZERO_COST_MODEL: CostModel = {
  feeBps: 0,
  slippageBps: 0,
  assumedHalfSpreadBps: 0,
  perOrderUsd: 0,
};

/**
 * Used when the asset class and venue can't be determined. Deliberately
 * pessimistic (Coinbase-tier fees): if a strategy survives this it will survive
 * anywhere, and an unknown venue is exactly when you want to be cautious.
 */
export const DEFAULT_COST_MODEL: CostModel = {
  feeBps: toBps(0.006),
  slippageBps: 5,
  assumedHalfSpreadBps: 5,
  perOrderUsd: 0,
};

/**
 * US equity retail. Commission-free at every broker b1dz connects to; the cost
 * is spread plus impact. Majors like SPY/AAPL sit around 1 bp of spread, so 2 bp
 * half-spread stays honest for the mid-cap end of a watchlist.
 */
export const EQUITY_COST_MODEL: CostModel = {
  feeBps: toBps(DEFAULT_EQUITY_COMMISSION),
  slippageBps: 2,
  assumedHalfSpreadBps: 2,
  perOrderUsd: 0,
};

/**
 * On-chain swap: pool fee dominates, impact is materially worse than a CEX, and
 * gas is a flat per-swap charge that makes small notionals uneconomic. Callers
 * with a live gas quote from @b1dz/adapters-evm should override `perOrderUsd`.
 */
export const DEX_COST_MODEL: CostModel = {
  feeBps: toBps(DEFAULT_DEX_POOL_FEE),
  slippageBps: 30,
  assumedHalfSpreadBps: 10,
  perOrderUsd: DEFAULT_DEX_GAS_USD,
};

/** Venue ids that are on-chain rather than centralized order books. */
const DEX_VENUES = new Set([
  'uniswap-v3',
  'uniswap-v3-base',
  'uniswap',
  '1inch',
  '0x',
  'zeroex',
  'jupiter',
  'pumpfun',
  'aggregator-base',
]);

export interface CostModelHint {
  assetClass?: 'crypto' | 'equity';
  /** Venue / exchange id, e.g. 'kraken', 'uniswap-v3-base', 'alpaca'. */
  exchange?: string;
}

/**
 * Pick a cost model from what we know about the series.
 *
 * Resolution order: explicit DEX venue → known CEX venue → declared asset class
 * → conservative default. Synthetic backtest venues ('yahoo', 'src', 'test')
 * carry no fee information, so they fall through to the asset class, which is
 * why `MarketSnapshot.assetClass` matters for pricing accuracy.
 */
export function costModelFor(hint: CostModelHint): CostModel {
  const venue = hint.exchange?.toLowerCase();

  if (venue && DEX_VENUES.has(venue)) return { ...DEX_COST_MODEL };

  if (venue && venue in CEX_FEE_LOOKUP) {
    return { ...DEFAULT_COST_MODEL, feeBps: toBps(cexTakerFee(venue)) };
  }

  if (hint.assetClass === 'equity') return { ...EQUITY_COST_MODEL };
  if (hint.assetClass === 'crypto') return { ...DEFAULT_COST_MODEL };

  return { ...DEFAULT_COST_MODEL };
}

/** Venue ids we have a real published fee for. */
const CEX_FEE_LOOKUP: Record<string, true> = {
  kraken: true,
  'binance-us': true,
  coinbase: true,
  gemini: true,
};

/** Derive a cost model from the first snapshot of a series. */
export function costModelForSeries(snapshots: MarketSnapshot[]): CostModel {
  const first = snapshots[0];
  if (!first) return { ...DEFAULT_COST_MODEL };
  return costModelFor({ assetClass: first.assetClass, exchange: first.exchange });
}

/** True when a snapshot carries a genuine two-sided quote rather than a synthesized close. */
export function hasRealSpread(snap: MarketSnapshot): boolean {
  return snap.bid > 0 && snap.ask > 0 && snap.ask > snap.bid;
}

/** Mid price; falls back to whichever side is present. */
export function midPrice(snap: MarketSnapshot): number {
  if (snap.bid > 0 && snap.ask > 0) return (snap.bid + snap.ask) / 2;
  return snap.bid || snap.ask || 0;
}

/**
 * The price a BUY actually fills at: the ask (real or synthesized from the
 * assumed half-spread), widened by slippage.
 */
export function effectiveBuyPrice(snap: MarketSnapshot, costs: CostModel): number {
  const base = hasRealSpread(snap)
    ? snap.ask
    : midPrice(snap) * (1 + costs.assumedHalfSpreadBps / 10_000);
  return base * (1 + costs.slippageBps / 10_000);
}

/**
 * The price a SELL actually fills at: the bid (real or synthesized), reduced by
 * slippage.
 */
export function effectiveSellPrice(snap: MarketSnapshot, costs: CostModel): number {
  const base = hasRealSpread(snap)
    ? snap.bid
    : midPrice(snap) * (1 - costs.assumedHalfSpreadBps / 10_000);
  return base * (1 - costs.slippageBps / 10_000);
}

/** Fee charged on one leg of `notionalUsd`. */
export function legFeeUsd(notionalUsd: number, costs: CostModel): number {
  return notionalUsd * (costs.feeBps / 10_000) + costs.perOrderUsd;
}

/**
 * Total round-trip friction in bps of notional, assuming no price movement.
 * The break-even hurdle: a strategy whose average winner is smaller than this
 * loses money no matter how high its win rate looks.
 *
 * Two fee legs + two slippage legs + one full spread (half in, half out), plus
 * the flat per-order cost expressed against `notionalUsd`.
 */
export function roundTripCostBps(costs: CostModel, notionalUsd = 100): number {
  const flatBps = notionalUsd > 0 ? (costs.perOrderUsd * 2 / notionalUsd) * 10_000 : 0;
  return costs.feeBps * 2 + costs.slippageBps * 2 + costs.assumedHalfSpreadBps * 2 + flatBps;
}

/** Human-readable one-liner for CLI/UI headers. */
export function describeCostModel(costs: CostModel, notionalUsd = 100): string {
  const parts = [`${costs.feeBps.toFixed(1)}bp fee/leg`];
  if (costs.slippageBps > 0) parts.push(`${costs.slippageBps.toFixed(1)}bp slip/leg`);
  if (costs.assumedHalfSpreadBps > 0) parts.push(`${costs.assumedHalfSpreadBps.toFixed(1)}bp half-spread`);
  if (costs.perOrderUsd > 0) parts.push(`$${costs.perOrderUsd.toFixed(2)}/order`);
  return `${parts.join(' · ')} → ${roundTripCostBps(costs, notionalUsd).toFixed(1)}bp round trip`;
}
