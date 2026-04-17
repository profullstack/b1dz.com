/**
 * Pure DCA backtest simulator. Takes historical candles per (exchange, coin)
 * and replays the planner across the timeline, reporting accumulated
 * positions and cost basis.
 *
 * Not live — no order placement, no balance checks. All accumulation is
 * purely modeled off candle.close at each simulated tick.
 */

import type { Candle } from './analysis/candles.js';
import type { DcaConfig } from './dca-config.js';
import { decideDcaBuys } from './dca-planner.js';

export interface DcaBacktestInput {
  config: DcaConfig;
  /** Candles keyed by `${exchange}:${coin}`. Must be sorted ascending by time. */
  candles: Map<string, Candle[]>;
  /** ms since epoch — start of backtest window. Defaults to earliest candle. */
  startMs?: number;
  /** ms since epoch — end of backtest window. Defaults to latest candle. */
  endMs?: number;
  /** Total equity in USD for sizing. Stays constant through the sim
   *  (we don't model equity changes from the DCA buys themselves, just
   *  track what would have been bought). */
  equityUsd: number;
  /** Fee rate applied to each buy, as a fraction. Default 0.003 (0.3%). */
  feeRate?: number;
}

export interface DcaBacktestBuy {
  at: number;
  exchange: string;
  coin: string;
  usdSpent: number;
  price: number;
  coinsAcquired: number;
  feeUsd: number;
}

export interface DcaBacktestPosition {
  exchange: string;
  coin: string;
  totalCoins: number;
  totalUsdSpent: number;
  totalFeesUsd: number;
  avgCostBasis: number;
  buys: number;
  /** Price at the end of the backtest window for PnL. */
  finalPrice: number;
  finalValueUsd: number;
  unrealizedPnlUsd: number;
  unrealizedPnlPct: number;
}

export interface DcaBacktestResult {
  buys: DcaBacktestBuy[];
  positions: DcaBacktestPosition[];
  totals: {
    buys: number;
    usdSpent: number;
    feesUsd: number;
    finalValueUsd: number;
    unrealizedPnlUsd: number;
    /** PnL as % of total USD spent. */
    unrealizedPnlPct: number;
  };
  periodDays: number;
}

/** Find the candle closest to (but not after) `t` in a sorted series. */
function priceAt(candles: Candle[], t: number): number | null {
  if (candles.length === 0) return null;
  if (t < candles[0]!.time) return null;
  // Binary search for the latest candle.time <= t.
  let lo = 0, hi = candles.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (candles[mid]!.time <= t) lo = mid;
    else hi = mid - 1;
  }
  return candles[lo]!.close;
}

export function runDcaBacktest(input: DcaBacktestInput): DcaBacktestResult {
  const feeRate = input.feeRate ?? 0.003;
  const cfg = input.config;
  const candles = input.candles;

  // Derive window bounds from provided candle series.
  let derivedStart = Infinity, derivedEnd = -Infinity;
  for (const series of candles.values()) {
    if (series.length === 0) continue;
    derivedStart = Math.min(derivedStart, series[0]!.time);
    derivedEnd = Math.max(derivedEnd, series.at(-1)!.time);
  }
  const startMs = input.startMs ?? (Number.isFinite(derivedStart) ? derivedStart : 0);
  const endMs = input.endMs ?? (Number.isFinite(derivedEnd) ? derivedEnd : 0);

  const buys: DcaBacktestBuy[] = [];
  const lastBuyAt = new Map<string, number>();
  const holdings = new Map<string, Set<string>>();
  for (const ex of cfg.exchanges) holdings.set(ex, new Set());

  const positionAcc = new Map<string, { coins: number; usdSpent: number; fees: number; buyCount: number }>();

  // Tick cadence — we check the planner once per INTERVAL_MS. Coarser than
  // live (60s tick) but deterministic and aligned with DCA's daily cadence.
  const tickStep = Math.max(60_000, cfg.intervalMs);
  for (let t = startMs; t <= endMs; t += tickStep) {
    const plan = decideDcaBuys({
      config: cfg,
      now: t,
      equityUsd: input.equityUsd,
      currentHoldings: holdings,
      lastBuyAt,
      isEligible: (exchange, coin) => {
        // Only eligible if we have price data for that (exchange, coin) at this tick.
        const series = candles.get(`${exchange}:${coin}`);
        return !!series && priceAt(series, t) !== null;
      },
    });

    for (const buy of plan) {
      const key = `${buy.exchange}:${buy.coin}`;
      const series = candles.get(key);
      if (!series) continue;
      const price = priceAt(series, t);
      if (!price || !(price > 0)) continue;

      const fee = buy.usdAmount * feeRate;
      const spentNetOfFee = buy.usdAmount - fee;
      const coinsAcquired = spentNetOfFee / price;

      buys.push({
        at: t,
        exchange: buy.exchange,
        coin: buy.coin,
        usdSpent: buy.usdAmount,
        price,
        coinsAcquired,
        feeUsd: fee,
      });

      // Track position + slot usage.
      const existing = positionAcc.get(key) ?? { coins: 0, usdSpent: 0, fees: 0, buyCount: 0 };
      existing.coins += coinsAcquired;
      existing.usdSpent += buy.usdAmount;
      existing.fees += fee;
      existing.buyCount += 1;
      positionAcc.set(key, existing);
      holdings.get(buy.exchange)?.add(buy.coin);
      lastBuyAt.set(key, t);
    }
  }

  const positions: DcaBacktestPosition[] = [];
  for (const [key, acc] of positionAcc) {
    const [exchange, coin] = key.split(':');
    const series = candles.get(key) ?? [];
    const finalPrice = series.length > 0 ? series.at(-1)!.close : 0;
    const finalValueUsd = acc.coins * finalPrice;
    const unrealizedPnlUsd = finalValueUsd - acc.usdSpent;
    const unrealizedPnlPct = acc.usdSpent > 0 ? (unrealizedPnlUsd / acc.usdSpent) * 100 : 0;
    positions.push({
      exchange: exchange!,
      coin: coin!,
      totalCoins: acc.coins,
      totalUsdSpent: acc.usdSpent,
      totalFeesUsd: acc.fees,
      avgCostBasis: acc.coins > 0 ? acc.usdSpent / acc.coins : 0,
      buys: acc.buyCount,
      finalPrice,
      finalValueUsd,
      unrealizedPnlUsd,
      unrealizedPnlPct,
    });
  }
  positions.sort((a, b) => b.finalValueUsd - a.finalValueUsd);

  const totals = positions.reduce(
    (acc, p) => ({
      buys: acc.buys + p.buys,
      usdSpent: acc.usdSpent + p.totalUsdSpent,
      feesUsd: acc.feesUsd + p.totalFeesUsd,
      finalValueUsd: acc.finalValueUsd + p.finalValueUsd,
      unrealizedPnlUsd: acc.unrealizedPnlUsd + p.unrealizedPnlUsd,
      unrealizedPnlPct: 0,
    }),
    { buys: 0, usdSpent: 0, feesUsd: 0, finalValueUsd: 0, unrealizedPnlUsd: 0, unrealizedPnlPct: 0 },
  );
  totals.unrealizedPnlPct = totals.usdSpent > 0 ? (totals.unrealizedPnlUsd / totals.usdSpent) * 100 : 0;
  const periodDays = (endMs - startMs) / 86_400_000;

  return { buys, positions, totals, periodDays };
}
