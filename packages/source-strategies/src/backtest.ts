/**
 * Strategy backtester — replay a StrategyPlugin's own signals over a snapshot
 * stream and score the result.
 *
 * Strategies are signals-only: evaluate() emits buy/sell Signals; it never sizes
 * or executes. This module turns that signal stream into long-only round-trip
 * trades so a strategy can be scored historically:
 *   - flat + buy  → open a position at the current mid, sized at `amountPerEntry`
 *   - long + sell → close it at the current mid
 *   - any position still open at the end is marked to the final bar
 *
 * It is deterministic and asset-agnostic — the same code scores BTC-USD ticks or
 * AAPL bars. The standalone ~/bin/backtest.js CLI and (later) the custom-strategy
 * wizard both drive this so their numbers agree. Costs (fees/slippage/spread) are
 * intentionally excluded; layer them on at the caller if needed.
 */
import type { MarketSnapshot, StrategyPlugin } from '@b1dz/core';

export interface BacktestTrade {
  entryTs: number;
  exitTs: number;
  entryPrice: number;
  exitPrice: number;
  shares: number;
  cost: number; // dollars put in at entry (= amountPerEntry)
  proceeds: number;
  profit: number;
  tradeReturnPct: number;
  entryReason: string;
  exitReason: string;
}

export interface BacktestSummary {
  trades: number;
  invested: number;
  proceeds: number;
  profit: number;
  returnPct: number;
  wins: number;
  losses: number;
  winRate: number;
  avgTradePct: number;
  maxDrawdown: number;
}

export const DEFAULT_AMOUNT_PER_ENTRY = 100;

/** Mid price of a snapshot; falls back to whichever side is present. */
function mid(snap: MarketSnapshot): number {
  if (snap.bid > 0 && snap.ask > 0) return (snap.bid + snap.ask) / 2;
  return snap.bid || snap.ask || 0;
}

interface OpenPosition {
  entryTs: number;
  entryPrice: number;
  cost: number;
  entryReason: string;
}

function close(position: OpenPosition, exitPrice: number, exitTs: number, exitReason: string): BacktestTrade {
  const shares = position.cost / position.entryPrice;
  const proceeds = shares * exitPrice;
  return {
    entryTs: position.entryTs,
    exitTs,
    entryPrice: position.entryPrice,
    exitPrice,
    shares,
    cost: position.cost,
    proceeds,
    profit: proceeds - position.cost,
    tradeReturnPct: exitPrice / position.entryPrice - 1,
    entryReason: position.entryReason,
    exitReason,
  };
}

/**
 * Replay `plugin` over `snapshots` (chronological) and return the round-trip
 * trades. A strategy that throws is treated as "no signal" for that bar so one
 * bad evaluate() can't abort the whole run.
 */
export function replayStrategy(
  plugin: StrategyPlugin,
  snapshots: MarketSnapshot[],
  amountPerEntry: number = DEFAULT_AMOUNT_PER_ENTRY,
): BacktestTrade[] {
  const trades: BacktestTrade[] = [];
  let position: OpenPosition | null = null;

  for (let i = 0; i < snapshots.length; i++) {
    const snap = snapshots[i]!;
    const history = snapshots.slice(0, i);
    const price = mid(snap);
    if (!(price > 0)) continue;

    let signal = null;
    try {
      signal = plugin.evaluate(snap, history);
    } catch {
      signal = null;
    }
    if (!signal) continue;

    if (!position && signal.side === 'buy') {
      position = { entryTs: snap.ts, entryPrice: price, cost: amountPerEntry, entryReason: signal.reason };
    } else if (position && signal.side === 'sell') {
      trades.push(close(position, price, snap.ts, signal.reason));
      position = null;
    }
  }

  if (position && snapshots.length) {
    const last = snapshots[snapshots.length - 1]!;
    trades.push(close(position, mid(last), last.ts, 'close at end'));
  }

  return trades;
}

/** Aggregate a set of trades into the headline metrics the store/CLI render. */
export function summarizeTrades(trades: BacktestTrade[]): BacktestSummary {
  const invested = trades.reduce((s, t) => s + t.cost, 0);
  const proceeds = trades.reduce((s, t) => s + t.proceeds, 0);
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

  return { trades: trades.length, invested, proceeds, profit, returnPct, wins, losses, winRate, avgTradePct, maxDrawdown };
}
