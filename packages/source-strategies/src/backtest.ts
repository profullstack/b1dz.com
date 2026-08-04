/**
 * Strategy backtester — replay a StrategyPlugin's own signals over a snapshot
 * stream and score the result NET OF TRADING COSTS.
 *
 * Strategies are signals-only: evaluate() emits buy/sell Signals; it never sizes
 * or executes. This module turns that signal stream into long-only round-trip
 * trades so a strategy can be scored historically:
 *   - flat + buy  → open a position at the effective ASK, sized at `amountPerEntry`
 *   - long + sell → close it at the effective BID
 *   - any position still open at the end is marked out to the final bar
 *
 * Every trade is priced through a `CostModel` (see ./costs.ts): fees on both
 * legs, the bid/ask spread, slippage, and any flat per-order cost. When `costs`
 * is omitted the model is derived from the series' own asset class and venue, so
 * the default is realistic rather than free — a zero-cost backtest is a
 * different game, not a conservative estimate of this one.
 *
 * `profit` is NET. `grossProfit` is pre-fee (but post spread/slippage, since
 * those are embedded in the fill prices). Pass `ZERO_COST_MODEL` explicitly if
 * you need the old frictionless numbers for comparison.
 *
 * Deterministic and asset-agnostic — the same code scores BTC-USD ticks and
 * AAPL daily bars.
 */
import type { MarketSnapshot, StrategyPlugin } from '@b1dz/core';
import {
  costModelForSeries,
  effectiveBuyPrice,
  effectiveSellPrice,
  legFeeUsd,
  midPrice,
  roundTripCostBps,
  type CostModel,
} from './costs.js';

export interface BacktestTrade {
  entryTs: number;
  exitTs: number;
  /** Effective fill price on entry — ask + slippage. */
  entryPrice: number;
  /** Effective fill price on exit — bid − slippage. */
  exitPrice: number;
  /** Frictionless mid at entry, for measuring what the costs took. */
  entryMid: number;
  /** Frictionless mid at exit. */
  exitMid: number;
  shares: number;
  /** Notional put to work at entry, before fees (= amountPerEntry). */
  notionalUsd: number;
  /** Total cash out of pocket at entry: notional + entry fee. */
  cost: number;
  /** Position value at exit before the exit fee. */
  grossProceeds: number;
  /** Cash back in hand after the exit fee. */
  proceeds: number;
  entryFeeUsd: number;
  exitFeeUsd: number;
  /** entryFeeUsd + exitFeeUsd. */
  feesUsd: number;
  /** What spread + slippage cost versus a frictionless mid-to-mid round trip. */
  spreadSlippageUsd: number;
  /** feesUsd + spreadSlippageUsd — total friction paid on this trade. */
  totalCostUsd: number;
  /** Total friction as bps of notional. The hurdle this trade had to clear. */
  costBps: number;
  /** Pre-fee profit (spread and slippage are already in the fill prices). */
  grossProfit: number;
  /** NET profit after fees, spread, slippage, and per-order costs. */
  profit: number;
  /** proceeds / cost — the factor to compound a bankroll slice by. */
  netMultiple: number;
  /** Net return on cash deployed. */
  tradeReturnPct: number;
  entryReason: string;
  exitReason: string;
}

export interface BacktestSummary {
  trades: number;
  /** Total cash deployed across entries, including entry fees. */
  invested: number;
  proceeds: number;
  /** NET profit. */
  profit: number;
  /** Pre-fee profit, for showing users what costs consumed. */
  grossProfit: number;
  feesUsd: number;
  spreadSlippageUsd: number;
  totalCostUsd: number;
  /** Total friction as a fraction of capital deployed. */
  costDragPct: number;
  returnPct: number;
  wins: number;
  losses: number;
  winRate: number;
  avgTradePct: number;
  maxDrawdown: number;
}

export const DEFAULT_AMOUNT_PER_ENTRY = 100;

export interface ReplayOptions {
  /** Notional deployed per entry, before fees. */
  amountPerEntry?: number;
  /** Cost model. Defaults to one derived from the series' asset class + venue. */
  costs?: CostModel;
}

interface OpenPosition {
  entryTs: number;
  entryPrice: number;
  entryMid: number;
  notionalUsd: number;
  entryFeeUsd: number;
  shares: number;
  entryReason: string;
}

function closeTrade(
  position: OpenPosition,
  exitPrice: number,
  exitMid: number,
  exitTs: number,
  exitReason: string,
  costs: CostModel,
): BacktestTrade {
  const grossProceeds = position.shares * exitPrice;
  const exitFeeUsd = legFeeUsd(grossProceeds, costs);
  const proceeds = grossProceeds - exitFeeUsd;
  const cost = position.notionalUsd + position.entryFeeUsd;

  // What a frictionless mid-to-mid round trip would have returned, for cost attribution.
  const idealShares = position.entryMid > 0 ? position.notionalUsd / position.entryMid : 0;
  const idealProceeds = idealShares * exitMid;
  const spreadSlippageUsd = idealProceeds - grossProceeds;

  const feesUsd = position.entryFeeUsd + exitFeeUsd;
  const totalCostUsd = feesUsd + spreadSlippageUsd;

  return {
    entryTs: position.entryTs,
    exitTs,
    entryPrice: position.entryPrice,
    exitPrice,
    entryMid: position.entryMid,
    exitMid,
    shares: position.shares,
    notionalUsd: position.notionalUsd,
    cost,
    grossProceeds,
    proceeds,
    entryFeeUsd: position.entryFeeUsd,
    exitFeeUsd,
    feesUsd,
    spreadSlippageUsd,
    totalCostUsd,
    costBps: position.notionalUsd > 0 ? (totalCostUsd / position.notionalUsd) * 10_000 : 0,
    grossProfit: grossProceeds - position.notionalUsd,
    profit: proceeds - cost,
    netMultiple: cost > 0 ? proceeds / cost : 1,
    tradeReturnPct: cost > 0 ? (proceeds - cost) / cost : 0,
    entryReason: position.entryReason,
    exitReason,
  };
}

/**
 * Replay `plugin` over `snapshots` (chronological) and return the round-trip
 * trades, net of costs. A strategy that throws is treated as "no signal" for
 * that bar so one bad evaluate() can't abort the whole run.
 *
 * The third argument accepts a bare number for backward compatibility with
 * `replayStrategy(plugin, snaps, 100)`.
 */
export function replayStrategy(
  plugin: StrategyPlugin,
  snapshots: MarketSnapshot[],
  optsOrAmount: number | ReplayOptions = {},
): BacktestTrade[] {
  const opts: ReplayOptions =
    typeof optsOrAmount === 'number' ? { amountPerEntry: optsOrAmount } : optsOrAmount;
  const amountPerEntry = opts.amountPerEntry ?? DEFAULT_AMOUNT_PER_ENTRY;
  const costs = opts.costs ?? costModelForSeries(snapshots);

  const trades: BacktestTrade[] = [];
  let position: OpenPosition | null = null;

  for (let i = 0; i < snapshots.length; i++) {
    const snap = snapshots[i]!;
    const history = snapshots.slice(0, i);
    const mid = midPrice(snap);
    if (!(mid > 0)) continue;

    let signal = null;
    try {
      signal = plugin.evaluate(snap, history);
    } catch {
      signal = null;
    }
    if (!signal) continue;

    if (!position && signal.side === 'buy') {
      const entryPrice = effectiveBuyPrice(snap, costs);
      if (!(entryPrice > 0)) continue;
      const entryFeeUsd = legFeeUsd(amountPerEntry, costs);
      position = {
        entryTs: snap.ts,
        entryPrice,
        entryMid: mid,
        notionalUsd: amountPerEntry,
        entryFeeUsd,
        shares: amountPerEntry / entryPrice,
        entryReason: signal.reason,
      };
    } else if (position && signal.side === 'sell') {
      trades.push(closeTrade(position, effectiveSellPrice(snap, costs), mid, snap.ts, signal.reason, costs));
      position = null;
    }
  }

  if (position && snapshots.length) {
    const last = snapshots[snapshots.length - 1]!;
    trades.push(
      closeTrade(position, effectiveSellPrice(last, costs), midPrice(last), last.ts, 'close at end', costs),
    );
  }

  return trades;
}

/**
 * Aggregate a set of trades into the headline metrics the store/CLI render.
 *
 * Wins and losses are counted on NET profit: a trade that gains 10 bps of price
 * and pays 60 bps of fees is a loss, and calling it a win is how a losing
 * strategy gets sold as a winning one.
 */
export function summarizeTrades(trades: BacktestTrade[]): BacktestSummary {
  const invested = trades.reduce((s, t) => s + t.cost, 0);
  const proceeds = trades.reduce((s, t) => s + t.proceeds, 0);
  const grossProfit = trades.reduce((s, t) => s + t.grossProfit, 0);
  const feesUsd = trades.reduce((s, t) => s + t.feesUsd, 0);
  const spreadSlippageUsd = trades.reduce((s, t) => s + t.spreadSlippageUsd, 0);
  const totalCostUsd = feesUsd + spreadSlippageUsd;
  const profit = proceeds - invested;
  const returnPct = invested > 0 ? profit / invested : 0;
  const wins = trades.filter((t) => t.profit > 0).length;
  const losses = trades.filter((t) => t.profit < 0).length;
  const winRate = trades.length ? wins / trades.length : 0;
  const avgTradePct = trades.length
    ? trades.reduce((s, t) => s + t.tradeReturnPct, 0) / trades.length
    : 0;

  let cum = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const t of trades) {
    cum += t.profit;
    peak = Math.max(peak, cum);
    maxDrawdown = Math.max(maxDrawdown, peak - cum);
  }

  return {
    trades: trades.length,
    invested,
    proceeds,
    profit,
    grossProfit,
    feesUsd,
    spreadSlippageUsd,
    totalCostUsd,
    costDragPct: invested > 0 ? totalCostUsd / invested : 0,
    returnPct,
    wins,
    losses,
    winRate,
    avgTradePct,
    maxDrawdown,
  };
}

/**
 * Break-even move a single round trip must clear, in bps, under `costs`.
 * Re-exported here because it is the number that decides whether a strategy is
 * viable at all on a given venue.
 */
export { roundTripCostBps };
