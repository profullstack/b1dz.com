import { DEFAULT_ANALYSIS_CONFIG, type AnalysisConfig } from './config.js';
import { aggregateCandles, type Candle } from './candles.js';
import { analyzeSignal, type AnalysisInput, type AnalysisSignal } from './engine.js';
import { computeBacktestMetrics, type BacktestMetrics, type BacktestTrade } from './analytics.js';

export interface BacktestAssumptions {
  startingEquityUsd: number;
  feeRate: number;
  slippagePct: number;
  spreadPct: number;
  latencyBars: number;
}

export interface BacktestInput {
  symbol: string;
  exchange: string;
  candles: Candle[];
  config?: AnalysisConfig;
  assumptions?: Partial<BacktestAssumptions>;
  signalEngine?: (input: AnalysisInput) => AnalysisSignal;
}

export interface BacktestResult {
  trades: BacktestTrade[];
  metrics: BacktestMetrics;
}

interface OpenBacktestPosition {
  direction: 'long' | 'short';
  regime: AnalysisSignal['regime'];
  setupType: NonNullable<AnalysisSignal['setupType']>;
  score: number;
  entryTime: number;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  volatilityBucket: 'low' | 'medium' | 'high';
}

const DEFAULT_ASSUMPTIONS: BacktestAssumptions = {
  startingEquityUsd: 100,
  feeRate: 0.006,
  slippagePct: 0.05,
  spreadPct: 0.05,
  latencyBars: 0,
};

function classifyVolatilityBucket(atrPct: number): 'low' | 'medium' | 'high' {
  if (atrPct < 0.25) return 'low';
  if (atrPct < 0.6) return 'medium';
  return 'high';
}

function makeAnalysisInput(
  symbol: string,
  exchange: string,
  visibleCandles: Candle[],
  config: AnalysisConfig,
  spreadPct: number,
): AnalysisInput {
  const latest = visibleCandles.at(-1)!;
  const spread = latest.close * (spreadPct / 100);
  return {
    symbol,
    exchange,
    latest: {
      exchange,
      pair: symbol,
      bid: latest.close - (spread / 2),
      ask: latest.close + (spread / 2),
      bidSize: Math.max(1, latest.volume),
      askSize: Math.max(1, latest.volume),
      ts: latest.time,
    },
    entryCandles: visibleCandles,
    confirmCandles: aggregateCandles(visibleCandles, config.timeframes.confirm),
    biasCandles: aggregateCandles(visibleCandles, config.timeframes.bias),
  };
}

function exitPriceForPosition(position: OpenBacktestPosition, candle: Candle): { price: number; reason: 'stop' | 'target' | null } {
  if (position.direction === 'long') {
    const hitStop = candle.low <= position.stopLoss;
    const hitTarget = candle.high >= position.takeProfit;
    if (hitStop && hitTarget) return { price: position.stopLoss, reason: 'stop' };
    if (hitStop) return { price: position.stopLoss, reason: 'stop' };
    if (hitTarget) return { price: position.takeProfit, reason: 'target' };
    return { price: 0, reason: null };
  }
  const hitStop = candle.high >= position.stopLoss;
  const hitTarget = candle.low <= position.takeProfit;
  if (hitStop && hitTarget) return { price: position.stopLoss, reason: 'stop' };
  if (hitStop) return { price: position.stopLoss, reason: 'stop' };
  if (hitTarget) return { price: position.takeProfit, reason: 'target' };
  return { price: 0, reason: null };
}

export function runBacktest(input: BacktestInput): BacktestResult {
  const config = input.config ?? DEFAULT_ANALYSIS_CONFIG;
  const assumptions = { ...DEFAULT_ASSUMPTIONS, ...(input.assumptions ?? {}) };
  const engine = input.signalEngine ?? analyzeSignal;
  const candles = [...input.candles].sort((a, b) => a.time - b.time);
  const trades: BacktestTrade[] = [];
  let position: OpenBacktestPosition | null = null;

  for (let index = 0; index < candles.length; index++) {
    const current = candles[index]!;
    const visible = candles.slice(0, index + 1);

    if (position) {
      const exit = exitPriceForPosition(position, current);
      if (exit.reason) {
        const exitSlippage = exit.price * (assumptions.slippagePct / 100);
        const filledExit = position.direction === 'long' ? exit.price - exitSlippage : exit.price + exitSlippage;
        const quantity = assumptions.startingEquityUsd / position.entryPrice;
        const grossPnl = position.direction === 'long'
          ? (filledExit - position.entryPrice) * quantity
          : (position.entryPrice - filledExit) * quantity;
        const fees = ((position.entryPrice * quantity) + (filledExit * quantity)) * assumptions.feeRate;
        const slippageCost = exitSlippage * quantity;
        const netPnl = grossPnl - fees;
        trades.push({
          symbol: input.symbol,
          exchange: input.exchange,
          direction: position.direction,
          regime: position.regime,
          setupType: position.setupType,
          score: position.score,
          entryTime: position.entryTime,
          exitTime: current.time,
          entryPrice: position.entryPrice,
          exitPrice: filledExit,
          stopLoss: position.stopLoss,
          takeProfit: position.takeProfit,
          grossPnl,
          fees,
          slippageCost,
          netPnl,
          holdMinutes: (current.time - position.entryTime) / 60_000,
          hourOfDay: new Date(position.entryTime).getUTCHours(),
          volatilityBucket: position.volatilityBucket,
        });
        position = null;
      }
    }

    if (position) continue;

    const signalBarIndex = index - assumptions.latencyBars;
    if (signalBarIndex < 0) continue;
    const signalVisible = candles.slice(0, signalBarIndex + 1);
    const analysisInput = makeAnalysisInput(input.symbol, input.exchange, signalVisible, config, assumptions.spreadPct);
    const analysis = engine(analysisInput);
    if (analysis.rejected || !analysis.direction || !analysis.setupType || !analysis.stopLoss || !analysis.takeProfit) continue;

    const fillSlippage = current.close * (assumptions.slippagePct / 100);
    const fillPrice = analysis.direction === 'long' ? current.close + fillSlippage : current.close - fillSlippage;
    position = {
      direction: analysis.direction,
      regime: analysis.regime,
      setupType: analysis.setupType,
      score: analysis.score,
      entryTime: current.time,
      entryPrice: fillPrice,
      stopLoss: analysis.stopLoss,
      takeProfit: analysis.takeProfit,
      volatilityBucket: classifyVolatilityBucket(analysis.indicators.atrPct),
    };
  }

  if (position) {
    const last = candles.at(-1)!;
    const exitSlippage = last.close * (assumptions.slippagePct / 100);
    const filledExit = position.direction === 'long' ? last.close - exitSlippage : last.close + exitSlippage;
    const quantity = assumptions.startingEquityUsd / position.entryPrice;
    const grossPnl = position.direction === 'long'
      ? (filledExit - position.entryPrice) * quantity
      : (position.entryPrice - filledExit) * quantity;
    const fees = ((position.entryPrice * quantity) + (filledExit * quantity)) * assumptions.feeRate;
    trades.push({
      symbol: input.symbol,
      exchange: input.exchange,
      direction: position.direction,
      regime: position.regime,
      setupType: position.setupType,
      score: position.score,
      entryTime: position.entryTime,
      exitTime: last.time,
      entryPrice: position.entryPrice,
      exitPrice: filledExit,
      stopLoss: position.stopLoss,
      takeProfit: position.takeProfit,
      grossPnl,
      fees,
      slippageCost: exitSlippage * quantity,
      netPnl: grossPnl - fees,
      holdMinutes: (last.time - position.entryTime) / 60_000,
      hourOfDay: new Date(position.entryTime).getUTCHours(),
      volatilityBucket: position.volatilityBucket,
    });
  }

  return {
    trades,
    metrics: computeBacktestMetrics(trades, assumptions.startingEquityUsd),
  };
}
