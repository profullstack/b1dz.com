/**
 * Presentation helpers for the strategy-backtest readout on store cards.
 *
 * Pure formatting/selection over the published results
 * (`src/data/strategy-backtests.json`, written by ~/bin/backtest.js). Kept out
 * of the server component so it's unit-testable in the node test environment.
 */

export interface BacktestHorizon {
  label: string;
  startYmd: string;
  endYmd: string;
  trades: number;
  returnPct: number;
  winRate: number;
  profit: number;
  maxDrawdown: number;
}

export interface BacktestStrategy {
  strategyId: string;
  name: string;
  tagline: string;
  horizons: BacktestHorizon[];
}

/** Horizons worth showing — ones where the strategy actually traded. */
export function visibleHorizons(strategy: BacktestStrategy): BacktestHorizon[] {
  return strategy.horizons.filter((h) => h.trades > 0);
}

/** Signed percent, one decimal: 0.085 → "+8.5%", -0.026 → "-2.6%". */
export function fmtReturnPct(n: number): string {
  return `${n >= 0 ? '+' : ''}${(n * 100).toFixed(1)}%`;
}

/** Win rate as a whole percent: 0.3803 → "38%". */
export function fmtWinRate(n: number): string {
  return `${Math.round(n * 100)}%`;
}
