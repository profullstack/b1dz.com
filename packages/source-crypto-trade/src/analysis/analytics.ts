import type { MarketRegime, SetupType } from './engine.js';

export interface BacktestTrade {
  symbol: string;
  exchange: string;
  direction: 'long' | 'short';
  regime: MarketRegime;
  setupType: SetupType;
  score: number;
  entryTime: number;
  exitTime: number;
  entryPrice: number;
  exitPrice: number;
  stopLoss: number;
  takeProfit: number;
  grossPnl: number;
  fees: number;
  slippageCost: number;
  netPnl: number;
  holdMinutes: number;
  hourOfDay: number;
  volatilityBucket: 'low' | 'medium' | 'high';
}

export interface AggregateBucket {
  trades: number;
  netPnl: number;
  wins: number;
  losses: number;
}

export interface BacktestMetrics {
  totalReturn: number;
  winRate: number;
  profitFactor: number;
  expectancy: number;
  maxDrawdown: number;
  sharpe: number;
  averageHoldMinutes: number;
  tradesPerDay: number;
  performanceBySymbol: Record<string, AggregateBucket>;
  performanceByRegime: Record<string, AggregateBucket>;
  performanceByHourOfDay: Record<string, AggregateBucket>;
  performanceByVolatilityBucket: Record<string, AggregateBucket>;
}

function emptyBucket(): AggregateBucket {
  return { trades: 0, netPnl: 0, wins: 0, losses: 0 };
}

function addToBucket(target: Record<string, AggregateBucket>, key: string, trade: BacktestTrade): void {
  const bucket = target[key] ?? (target[key] = emptyBucket());
  bucket.trades += 1;
  bucket.netPnl += trade.netPnl;
  if (trade.netPnl >= 0) bucket.wins += 1;
  else bucket.losses += 1;
}

function maxDrawdownFromCurve(startingEquityUsd: number, trades: BacktestTrade[]): number {
  let equity = startingEquityUsd;
  let peak = startingEquityUsd;
  let maxDrawdown = 0;
  for (const trade of trades) {
    equity += trade.netPnl;
    peak = Math.max(peak, equity);
    if (peak > 0) {
      maxDrawdown = Math.max(maxDrawdown, ((peak - equity) / peak) * 100);
    }
  }
  return maxDrawdown;
}

function sharpeFromTrades(startingEquityUsd: number, trades: BacktestTrade[]): number {
  if (trades.length < 2 || startingEquityUsd <= 0) return 0;
  const returns = trades.map((trade) => trade.netPnl / startingEquityUsd);
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance = returns.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / (returns.length - 1);
  const std = Math.sqrt(variance);
  if (std === 0) return 0;
  return mean / std * Math.sqrt(returns.length);
}

export function computeBacktestMetrics(trades: BacktestTrade[], startingEquityUsd: number): BacktestMetrics {
  const totalNet = trades.reduce((sum, trade) => sum + trade.netPnl, 0);
  const wins = trades.filter((trade) => trade.netPnl >= 0);
  const losses = trades.filter((trade) => trade.netPnl < 0);
  const grossProfit = wins.reduce((sum, trade) => sum + trade.netPnl, 0);
  const grossLoss = Math.abs(losses.reduce((sum, trade) => sum + trade.netPnl, 0));
  const firstEntry = trades[0]?.entryTime ?? 0;
  const lastExit = trades.at(-1)?.exitTime ?? firstEntry;
  const spanDays = Math.max(1, (lastExit - firstEntry) / 86_400_000);

  const performanceBySymbol: Record<string, AggregateBucket> = {};
  const performanceByRegime: Record<string, AggregateBucket> = {};
  const performanceByHourOfDay: Record<string, AggregateBucket> = {};
  const performanceByVolatilityBucket: Record<string, AggregateBucket> = {};

  for (const trade of trades) {
    addToBucket(performanceBySymbol, trade.symbol, trade);
    addToBucket(performanceByRegime, trade.regime, trade);
    addToBucket(performanceByHourOfDay, String(trade.hourOfDay), trade);
    addToBucket(performanceByVolatilityBucket, trade.volatilityBucket, trade);
  }

  return {
    totalReturn: startingEquityUsd > 0 ? (totalNet / startingEquityUsd) * 100 : 0,
    winRate: trades.length > 0 ? (wins.length / trades.length) * 100 : 0,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? Number.POSITIVE_INFINITY : 0),
    expectancy: trades.length > 0 ? totalNet / trades.length : 0,
    maxDrawdown: maxDrawdownFromCurve(startingEquityUsd, trades),
    sharpe: sharpeFromTrades(startingEquityUsd, trades),
    averageHoldMinutes: trades.length > 0 ? trades.reduce((sum, trade) => sum + trade.holdMinutes, 0) / trades.length : 0,
    tradesPerDay: trades.length / spanDays,
    performanceBySymbol,
    performanceByRegime,
    performanceByHourOfDay,
    performanceByVolatilityBucket,
  };
}
