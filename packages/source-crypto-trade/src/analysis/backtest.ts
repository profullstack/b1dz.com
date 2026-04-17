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
  /** Post-entry window during which trailing-stop + strategy-sell exits are
   *  suppressed (unless pnl is beneath hardStopPct). Mirrors live MIN_HOLD_MS.
   *  Default 120_000 (2 min). Set 0 to disable. */
  minHoldMs?: number;
  /** Negative fraction. Stops that breach this threshold override min-hold
   *  and 15m-uptrend guards. Default -0.02 (-2%). */
  hardStopPct?: number;
  /** If true, honors 15m uptrend guard: while analysis.confirmTrend is
   *  'bull' and pnl > hardStopPct, trailing-stop exits are suppressed.
   *  Default true (matches live). Set false for an apples-to-apples
   *  comparison with pre-guard behavior. */
  honorUptrendGuard?: boolean;
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
  minHoldMs: 120_000,
  hardStopPct: -0.02,
  honorUptrendGuard: true,
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
  opts?: {
    /** 15m higher-TF trend from analysis engine at this bar. */
    confirmTrend?: 'bull' | 'bear' | 'neutral' | null;
    minHoldMs?: number;
    hardStopPct?: number;
    honorUptrendGuard?: boolean;
  },
): { price: number; reason: ExitReason } | null {
  const stopPrice = trailingStopPriceFor(entryPrice, highWaterMark);
  const minHoldMs = opts?.minHoldMs ?? 0;
  const hardStopPct = opts?.hardStopPct ?? -Infinity;
  const elapsedMs = candle.time - entryTime;
  const stopPnl = (stopPrice - entryPrice) / entryPrice;
  const inMinHold = elapsedMs < minHoldMs;
  const holdForUptrend = opts?.honorUptrendGuard !== false
    && opts?.confirmTrend === 'bull'
    && stopPnl > hardStopPct;

  // Pessimistic ordering: assume stop triggers first when both would hit on
  // the same bar, so backtest is conservative.
  if (candle.low <= stopPrice) {
    // Hard-stop always exits.
    if (stopPnl <= hardStopPct) return { price: stopPrice, reason: 'stop' };
    // Guards suppress otherwise-normal stop hits.
    if (!inMinHold && !holdForUptrend) return { price: stopPrice, reason: 'stop' };
    // Guard held — fall through, check other exits.
  }
  if (candle.high >= takeProfit) return { price: takeProfit, reason: 'target' };

  // Time-based flat exit: if position has been open TIME_EXIT_MS and close
  // is within ±TIME_EXIT_FLAT_PCT of entry, exit at close.
  if (elapsedMs >= TIME_EXIT_MS) {
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
      // Compute confirmTrend for this bar so the exit guard has the same
      // 15m-uptrend signal the live daemon uses.
      const exitSignalBarIndex = index - assumptions.latencyBars;
      let exitConfirmTrend: 'bull' | 'bear' | 'neutral' | null = null;
      if (exitSignalBarIndex >= 0) {
        const visible = candles.slice(0, exitSignalBarIndex + 1);
        const exitAnalysis = engine(makeAnalysisInput(input.symbol, input.exchange, visible, config, assumptions.spreadPct));
        exitConfirmTrend = exitAnalysis.confirmTrend ?? null;
      }
      const exit = resolveLongExit(current, position.entryPrice, position.highWaterMark, position.takeProfit, position.entryTime, {
        confirmTrend: exitConfirmTrend,
        minHoldMs: assumptions.minHoldMs,
        hardStopPct: assumptions.hardStopPct,
        honorUptrendGuard: assumptions.honorUptrendGuard,
      });
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

// ──────────────────────────────────────────────────────────────────────
// Multi-pair exchange-aware backtest
// ──────────────────────────────────────────────────────────────────────
//
// The single-pair runBacktest above treats each pair as if it had its
// own $100 budget and could always take a signal. Live doesn't: only one
// position per exchange at a time, per-pair cooldown, and a single
// daily-loss halt shared across all pairs.
//
// runMultiPairBacktest iterates time-major across all pairs on one
// exchange, gates entries with those shared rules, and picks the
// highest-scoring signal when multiple fire simultaneously.

export interface BacktestPairCandles {
  symbol: string;
  candles: Candle[];
}

export interface BacktestMultiInput {
  exchange: string;
  pairs: BacktestPairCandles[];
  config?: AnalysisConfig;
  assumptions?: Partial<BacktestAssumptions>;
  signalEngine?: (input: AnalysisInput) => AnalysisSignal;
}

export interface BacktestMultiResult {
  trades: BacktestTrade[];
  metrics: BacktestMetrics;
  haltedByDailyLossLimit: boolean;
  /** Count of signals that would have fired in single-pair mode but were
   *  blocked because another pair already held the exchange position. */
  signalsSkippedForOpenPosition: number;
  /** Per-pair trade counts derived from `trades` for convenience. */
  perPair: Record<string, { trades: number; netPnl: number; candles: number }>;
}

interface MultiPairPosition extends OpenBacktestPosition {
  symbol: string;
}

export function runMultiPairBacktest(input: BacktestMultiInput): BacktestMultiResult {
  const config = input.config ?? DEFAULT_ANALYSIS_CONFIG;
  const assumptions = { ...DEFAULT_ASSUMPTIONS, ...(input.assumptions ?? {}) };
  const engine = input.signalEngine ?? analyzeSignal;
  const exchange = input.exchange;

  // Sort each pair's candles and build a lookup: pair symbol → sorted candles.
  const pairCandles = new Map<string, Candle[]>();
  for (const p of input.pairs) {
    const sorted = [...p.candles].sort((a, b) => a.time - b.time);
    if (sorted.length > 0) pairCandles.set(p.symbol, sorted);
  }

  // Union of all candle timestamps across pairs — the master timeline.
  const timestampSet = new Set<number>();
  for (const candles of pairCandles.values()) {
    for (const c of candles) timestampSet.add(c.time);
  }
  const timestamps = [...timestampSet].sort((a, b) => a - b);

  // Per-pair running index, used to advance through each pair's candles
  // without re-scanning from the start every tick.
  const indexByPair = new Map<string, number>();
  for (const symbol of pairCandles.keys()) indexByPair.set(symbol, -1);

  function advancePairTo(symbol: string, ts: number): Candle | null {
    const candles = pairCandles.get(symbol);
    if (!candles) return null;
    let idx = indexByPair.get(symbol) ?? -1;
    while (idx + 1 < candles.length && candles[idx + 1]!.time <= ts) idx++;
    indexByPair.set(symbol, idx);
    if (idx < 0) return null;
    const candle = candles[idx]!;
    return candle.time === ts ? candle : null;
  }

  function visibleFor(symbol: string, ts: number): Candle[] {
    const candles = pairCandles.get(symbol);
    if (!candles) return [];
    const idx = indexByPair.get(symbol) ?? -1;
    if (idx < 0) return [];
    const candle = candles[idx]!;
    if (candle.time !== ts) return [];
    return candles.slice(0, idx + 1);
  }

  const trades: BacktestTrade[] = [];
  let position: MultiPairPosition | null = null;
  const lastExitByPair = new Map<string, number>();
  const dailyRealizedPnlByDayUtc = new Map<string, number>();
  const dailyLossLimitPct = assumptions.dailyLossLimitPct ?? DAILY_LOSS_LIMIT_PCT_DEFAULT;
  const dailyLossLimitUsd = assumptions.startingEquityUsd * (dailyLossLimitPct / 100);
  let haltedByDailyLossLimit = false;
  let signalsSkippedForOpenPosition = 0;

  function utcDayKey(ts: number): string {
    return new Date(ts).toISOString().slice(0, 10);
  }

  function isDailyLossLimitHit(ts: number): boolean {
    const net = dailyRealizedPnlByDayUtc.get(utcDayKey(ts)) ?? 0;
    return net <= -dailyLossLimitUsd;
  }

  function closePosition(pos: MultiPairPosition, exitPrice: number, exitTime: number): void {
    const exitSlippage = exitPrice * (assumptions.slippagePct / 100);
    const filledExit = exitPrice - exitSlippage;
    const quantity = assumptions.startingEquityUsd / pos.entryPrice;
    const grossPnl = (filledExit - pos.entryPrice) * quantity;
    const fees = ((pos.entryPrice * quantity) + (filledExit * quantity)) * assumptions.feeRate;
    const slippageCost = exitSlippage * quantity;
    const netPnl = grossPnl - fees;
    trades.push({
      symbol: pos.symbol,
      exchange,
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
    lastExitByPair.set(pos.symbol, exitTime);
    const key = utcDayKey(pos.entryTime);
    dailyRealizedPnlByDayUtc.set(key, (dailyRealizedPnlByDayUtc.get(key) ?? 0) + netPnl);
    if (!haltedByDailyLossLimit && isDailyLossLimitHit(pos.entryTime)) {
      haltedByDailyLossLimit = true;
    }
  }

  for (const ts of timestamps) {
    // 1) Exit check on the open position (if any). We advance that pair's
    //    cursor to ts and evaluate exits against its current candle.
    if (position) {
      const c = advancePairTo(position.symbol, ts);
      if (c) {
        // Compute confirmTrend for the open-position's pair so the exit
        // guard has the same 15m-uptrend signal as live.
        const visible = visibleFor(position.symbol, ts);
        let exitConfirmTrend: 'bull' | 'bear' | 'neutral' | null = null;
        if (visible.length > 0) {
          const exitAnalysis = engine(makeAnalysisInput(position.symbol, exchange, visible, config, assumptions.spreadPct));
          exitConfirmTrend = exitAnalysis.confirmTrend ?? null;
        }
        const exit = resolveLongExit(c, position.entryPrice, position.highWaterMark, position.takeProfit, position.entryTime, {
          confirmTrend: exitConfirmTrend,
          minHoldMs: assumptions.minHoldMs,
          hardStopPct: assumptions.hardStopPct,
          honorUptrendGuard: assumptions.honorUptrendGuard,
        });
        if (exit) {
          closePosition(position, exit.price, ts);
          position = null;
        } else {
          if (c.high > position.highWaterMark) position.highWaterMark = c.high;
        }
      }
    }

    // 2) Advance all non-position pair cursors to ts so their visible
    //    history stays accurate for signal evaluation next.
    for (const symbol of pairCandles.keys()) {
      if (!position || symbol !== position.symbol) advancePairTo(symbol, ts);
    }

    // 3) Daily-halt gate (applies across entire exchange).
    if (isDailyLossLimitHit(ts)) continue;

    // 4) Already have an open position on this exchange: skip entries.
    //    But count signals that would have fired so the user can see how
    //    much the position-per-exchange rule is filtering.
    if (position) {
      for (const symbol of pairCandles.keys()) {
        if (symbol === position.symbol) continue;
        const visible = visibleFor(symbol, ts);
        if (visible.length === 0) continue;
        const analysisInput = makeAnalysisInput(symbol, exchange, visible, config, assumptions.spreadPct);
        const analysis = engine(analysisInput);
        if (!analysis.rejected && analysis.direction === 'long' && analysis.setupType) {
          signalsSkippedForOpenPosition++;
        }
      }
      continue;
    }

    // 5) No position open: evaluate every pair, pick the highest-scoring
    //    long signal, enter it. Respect per-pair cooldown.
    let best: { symbol: string; analysis: AnalysisSignal; candle: Candle } | null = null;
    for (const symbol of pairCandles.keys()) {
      const lastExit = lastExitByPair.get(symbol) ?? -Infinity;
      if (ts - lastExit < COOLDOWN_MS) continue;
      const visible = visibleFor(symbol, ts);
      if (visible.length === 0) continue;
      const candle = visible.at(-1)!;
      const analysisInput = makeAnalysisInput(symbol, exchange, visible, config, assumptions.spreadPct);
      const analysis = engine(analysisInput);
      if (analysis.rejected || !analysis.direction || !analysis.setupType || analysis.direction !== 'long') continue;
      if (!best || analysis.score > best.analysis.score) {
        best = { symbol, analysis, candle };
      }
    }

    if (!best) continue;

    const fillSlippage = best.candle.close * (assumptions.slippagePct / 100);
    const fillPrice = best.candle.close + fillSlippage;
    position = {
      symbol: best.symbol,
      direction: 'long',
      regime: best.analysis.regime,
      setupType: best.analysis.setupType!,
      score: best.analysis.score,
      entryTime: ts,
      entryPrice: fillPrice,
      takeProfit: fillPrice * (1 + TAKE_PROFIT_PCT),
      highWaterMark: fillPrice,
      volatilityBucket: classifyVolatilityBucket(best.analysis.indicators.atrPct),
    };
  }

  // Close any dangling position at end of data.
  if (position) {
    const candles = pairCandles.get(position.symbol);
    const last = candles?.at(-1);
    if (last) closePosition(position, last.close, last.time);
    position = null;
  }

  const perPair: Record<string, { trades: number; netPnl: number; candles: number }> = {};
  for (const { symbol } of input.pairs) {
    perPair[symbol] = {
      trades: 0,
      netPnl: 0,
      candles: (pairCandles.get(symbol)?.length ?? 0),
    };
  }
  for (const t of trades) {
    const bucket = perPair[t.symbol] ?? (perPair[t.symbol] = { trades: 0, netPnl: 0, candles: 0 });
    bucket.trades++;
    bucket.netPnl += t.netPnl;
  }

  return {
    trades,
    metrics: computeBacktestMetrics(trades, assumptions.startingEquityUsd),
    haltedByDailyLossLimit,
    signalsSkippedForOpenPosition,
    perPair,
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
