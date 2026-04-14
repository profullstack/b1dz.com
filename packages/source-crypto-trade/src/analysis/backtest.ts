import { DEFAULT_ANALYSIS_CONFIG, type AnalysisConfig } from './config.js';
import { aggregateCandles, type Candle } from './candles.js';
import { analyzeSignal, type AnalysisInput, type AnalysisSignal } from './engine.js';
import { computeBacktestMetrics, type BacktestMetrics, type BacktestTrade } from './analytics.js';
import {
  TAKE_PROFIT_PCT,
  BREAKEVEN_TRIGGER_PCT,
  LOCK_TRIGGER_PCT,
  LOCK_STOP_PCT,
  INITIAL_STOP_PCT,
  TIME_EXIT_MS,
  TIME_EXIT_FLAT_PCT,
  COOLDOWN_MS,
  DAILY_LOSS_LIMIT_PCT_DEFAULT,
  trailingStopPriceFor,
} from '../trade-config.js';

export interface BacktestAssumptions {
  startingEquityUsd: number;
  feeRate: number;
  slippagePct: number;
  spreadPct: number;
  latencyBars: number;
  /** Override the live daily-loss halt. Leave undefined to use the live default. */
  dailyLossLimitPct?: number;
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
  haltedByDailyLossLimit: boolean;
}

type ExitReason = 'stop' | 'target' | 'time_exit' | 'end_of_data';

interface OpenBacktestPosition {
  direction: 'long' | 'short';
  regime: AnalysisSignal['regime'];
  setupType: NonNullable<AnalysisSignal['setupType']>;
  score: number;
  entryTime: number;
  entryPrice: number;
  /** Fixed take-profit price (mirrors live TAKE_PROFIT_PCT). */
  takeProfit: number;
  /** Highest price seen since entry — used by trailing stop. */
  highWaterMark: number;
  volatilityBucket: 'low' | 'medium' | 'high';
}

const DEFAULT_ASSUMPTIONS: BacktestAssumptions = {
  startingEquityUsd: 100,
  // Realistic blended taker fee: Kraken 0.26%, Binance.US 0.10%, Coinbase 0.60%.
  // 0.3% is a weighted estimate assuming most volume on Kraken/Binance.US.
  feeRate: 0.003,
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

/**
 * Determine whether the current candle's range triggers an exit for a long
 * position, given the current live-style trailing stop and fixed target.
 * Live logic currently only trades long (no short support in daemon exits),
 * so we apply the same constraint here.
 */
function resolveLongExit(
  candle: Candle,
  entryPrice: number,
  highWaterMark: number,
  takeProfit: number,
  entryTime: number,
): { price: number; reason: ExitReason } | null {
  const stopPrice = trailingStopPriceFor(entryPrice, highWaterMark);

  // Pessimistic ordering: assume stop triggers first when both would hit on
  // the same bar, so backtest is conservative.
  if (candle.low <= stopPrice) return { price: stopPrice, reason: 'stop' };
  if (candle.high >= takeProfit) return { price: takeProfit, reason: 'target' };

  // Time-based flat exit: if position has been open TIME_EXIT_MS and close
  // is within ±TIME_EXIT_FLAT_PCT of entry, exit at close.
  if (candle.time - entryTime >= TIME_EXIT_MS) {
    const pnlFromClose = (candle.close - entryPrice) / entryPrice;
    if (Math.abs(pnlFromClose) < TIME_EXIT_FLAT_PCT) {
      return { price: candle.close, reason: 'time_exit' };
    }
  }
  return null;
}

export function runBacktest(input: BacktestInput): BacktestResult {
  const config = input.config ?? DEFAULT_ANALYSIS_CONFIG;
  const assumptions = { ...DEFAULT_ASSUMPTIONS, ...(input.assumptions ?? {}) };
  const engine = input.signalEngine ?? analyzeSignal;
  const candles = [...input.candles].sort((a, b) => a.time - b.time);
  const trades: BacktestTrade[] = [];
  let position: OpenBacktestPosition | null = null;

  // Live-parity state:
  //   - lastExitTime: pair-level cooldown gate (COOLDOWN_MS)
  //   - dailyRealizedPnlByDayUtc: start-of-day equity cap tracked by UTC day
  //   - haltedByDailyLossLimit: once tripped for a UTC day, we stop entering
  //     for the rest of that day. Resets the next day.
  let lastExitTime = -Infinity;
  const dailyRealizedPnlByDayUtc = new Map<string, number>();
  const dailyLossLimitPct = assumptions.dailyLossLimitPct ?? DAILY_LOSS_LIMIT_PCT_DEFAULT;
  const dailyLossLimitUsd = assumptions.startingEquityUsd * (dailyLossLimitPct / 100);
  let haltedByDailyLossLimit = false;

  function utcDayKey(ts: number): string {
    return new Date(ts).toISOString().slice(0, 10);
  }

  function isDailyLossLimitHit(ts: number): boolean {
    const net = dailyRealizedPnlByDayUtc.get(utcDayKey(ts)) ?? 0;
    return net <= -dailyLossLimitUsd;
  }

  function closeLongPosition(pos: OpenBacktestPosition, exitPrice: number, exitTime: number, reason: ExitReason): void {
    const exitSlippage = exitPrice * (assumptions.slippagePct / 100);
    const filledExit = exitPrice - exitSlippage;
    const quantity = assumptions.startingEquityUsd / pos.entryPrice;
    const grossPnl = (filledExit - pos.entryPrice) * quantity;
    const fees = ((pos.entryPrice * quantity) + (filledExit * quantity)) * assumptions.feeRate;
    const slippageCost = exitSlippage * quantity;
    const netPnl = grossPnl - fees;
    trades.push({
      symbol: input.symbol,
      exchange: input.exchange,
      direction: pos.direction,
      regime: pos.regime,
      setupType: pos.setupType,
      score: pos.score,
      entryTime: pos.entryTime,
      exitTime,
      entryPrice: pos.entryPrice,
      exitPrice: filledExit,
      stopLoss: trailingStopPriceFor(pos.entryPrice, pos.highWaterMark),
      takeProfit: pos.takeProfit,
      grossPnl,
      fees,
      slippageCost,
      netPnl,
      holdMinutes: (exitTime - pos.entryTime) / 60_000,
      hourOfDay: new Date(pos.entryTime).getUTCHours(),
      volatilityBucket: pos.volatilityBucket,
    });
    const key = utcDayKey(pos.entryTime);
    dailyRealizedPnlByDayUtc.set(key, (dailyRealizedPnlByDayUtc.get(key) ?? 0) + netPnl);
    if (!haltedByDailyLossLimit && isDailyLossLimitHit(pos.entryTime)) {
      haltedByDailyLossLimit = true;
    }
    lastExitTime = exitTime;
    void reason; // reason recorded implicitly via exit price vs stops/target
  }

  for (let index = 0; index < candles.length; index++) {
    const current = candles[index]!;

    // 1) Check exits against the PRIOR bar's high-water mark (pessimistic —
    //    assume the adverse price move within this bar hit before the
    //    favorable one). This is how a conservative backtest should treat
    //    intra-bar ordering since we can't see the tick sequence.
    if (position && position.direction === 'long') {
      const exit = resolveLongExit(current, position.entryPrice, position.highWaterMark, position.takeProfit, position.entryTime);
      if (exit) {
        closeLongPosition(position, exit.price, current.time, exit.reason);
        position = null;
      }
    }

    // 2) If still open, update the high-water mark using this bar's high so
    //    the next bar's trailing stop sees the new peak.
    if (position && position.direction === 'long' && current.high > position.highWaterMark) {
      position.highWaterMark = current.high;
    }

    if (position) continue;

    // 3) Entry gating — all the live rules mirrored here:
    //    - cooldown after last exit
    //    - daily-loss halt (trips once per UTC day; resets next day naturally
    //      because dailyRealizedPnlByDayUtc is keyed by day)
    if (current.time - lastExitTime < COOLDOWN_MS) continue;
    if (isDailyLossLimitHit(current.time)) continue;

    const signalBarIndex = index - assumptions.latencyBars;
    if (signalBarIndex < 0) continue;
    const signalVisible = candles.slice(0, signalBarIndex + 1);
    const analysisInput = makeAnalysisInput(input.symbol, input.exchange, signalVisible, config, assumptions.spreadPct);
    const analysis = engine(analysisInput);
    if (analysis.rejected || !analysis.direction || !analysis.setupType) continue;

    // Live daemon only opens longs (no shorts today). Mirror that for parity.
    if (analysis.direction !== 'long') continue;

    const fillSlippage = current.close * (assumptions.slippagePct / 100);
    const fillPrice = current.close + fillSlippage;
    position = {
      direction: 'long',
      regime: analysis.regime,
      setupType: analysis.setupType,
      score: analysis.score,
      entryTime: current.time,
      entryPrice: fillPrice,
      takeProfit: fillPrice * (1 + TAKE_PROFIT_PCT),
      highWaterMark: fillPrice,
      volatilityBucket: classifyVolatilityBucket(analysis.indicators.atrPct),
    };
  }

  // End-of-data: close any dangling position at the last close.
  if (position && position.direction === 'long') {
    const last = candles.at(-1)!;
    closeLongPosition(position, last.close, last.time, 'end_of_data');
    position = null;
  }

  return {
    trades,
    metrics: computeBacktestMetrics(trades, assumptions.startingEquityUsd),
    haltedByDailyLossLimit,
  };
}

// Unused constants re-exported so consumers can inspect live parameters.
export {
  TAKE_PROFIT_PCT,
  INITIAL_STOP_PCT,
  BREAKEVEN_TRIGGER_PCT,
  LOCK_TRIGGER_PCT,
  LOCK_STOP_PCT,
  COOLDOWN_MS,
  TIME_EXIT_MS,
};
