import type { MarketSnapshot } from '@b1dz/core';
import { DEFAULT_ANALYSIS_CONFIG, type AnalysisConfig } from './config.js';
import type { AnalysisTimeframe, Candle } from './candles.js';
import { atr, averageVolume, ema, intradayVwap, macd, rsi } from './indicators.js';

export type MarketRegime = 'uptrend' | 'downtrend' | 'sideways' | 'breakout_expansion' | 'compression';
export type SetupType =
  | 'long_trend_continuation'
  | 'short_trend_continuation'
  | 'long_mean_reversion'
  | 'short_mean_reversion'
  | 'breakout'
  | 'breakdown';

export interface AnalysisSignal {
  symbol: string;
  exchange: string;
  timestamp: number;
  timeframe: AnalysisTimeframe;
  regime: MarketRegime;
  setupType: SetupType | null;
  score: number;
  direction: 'long' | 'short' | null;
  entryBias: 'market_or_limit' | null;
  entryZone: { min: number; max: number } | null;
  stopLoss: number | null;
  takeProfit: number | null;
  riskReward: number | null;
  indicators: {
    emaFast: number;
    emaSlow: number;
    emaTrend: number;
    rsi: number;
    macdLine: number;
    macdSignal: number;
    macdHistogram: number;
    vwap: number;
    atr: number;
    atrPct: number;
    volumeRatio: number;
    spreadPct: number;
  };
  reasons: string[];
  rejectReasons: string[];
  rejected: boolean;
  confidence: number;
}

export interface AnalysisInput {
  symbol: string;
  exchange: string;
  latest: MarketSnapshot;
  entryCandles: Candle[];
  confirmCandles: Candle[];
  biasCandles: Candle[];
  cooldownActive?: boolean;
  killSwitchActive?: boolean;
  config?: AnalysisConfig;
}

function pctChange(current: number, previous: number): number {
  if (!Number.isFinite(previous) || previous === 0) return 0;
  return ((current - previous) / previous) * 100;
}

function spreadPctFromSnapshot(latest: MarketSnapshot): number {
  const mid = (latest.bid + latest.ask) / 2;
  return mid > 0 ? ((latest.ask - latest.bid) / mid) * 100 : 0;
}

function classifyRegime(
  close: number,
  emaFastValue: number,
  emaSlowValue: number,
  vwap: number,
  atrPct: number,
  volumeRatio: number,
  recentHigh: number,
  recentLow: number,
): MarketRegime {
  const aboveTrend = close > emaFastValue && close > emaSlowValue && close > vwap;
  const belowTrend = close < emaFastValue && close < emaSlowValue && close < vwap;
  const rangePct = recentLow > 0 ? ((recentHigh - recentLow) / recentLow) * 100 : 0;
  const brokeHigh = close >= recentHigh;
  const brokeLow = close <= recentLow;

  if (atrPct < 0.18 && rangePct < 1.0) return 'compression';
  if (atrPct >= 0.35 && volumeRatio >= 1.2 && brokeHigh) return 'breakout_expansion';
  if (atrPct >= 0.35 && volumeRatio >= 1.2 && brokeLow) return 'breakout_expansion';
  if (aboveTrend) return 'uptrend';
  if (belowTrend) return 'downtrend';
  return 'sideways';
}

function buildCandidate(
  direction: 'long' | 'short',
  setupType: SetupType,
  close: number,
  atrValue: number,
  score: number,
  reasons: string[],
  risk: AnalysisConfig['risk'],
) {
  const clampedScore = Math.max(0, Math.min(100, Math.round(score)));
  const stopDistance = atrValue * risk.defaultAtrStopMultiple;
  const targetDistance = atrValue * risk.defaultAtrTargetMultiple;
  const stopLoss = direction === 'long' ? close - stopDistance : close + stopDistance;
  const takeProfit = direction === 'long' ? close + targetDistance : close - targetDistance;
  const riskReward = stopDistance > 0 ? targetDistance / stopDistance : null;
  return {
    direction,
    setupType,
    score: clampedScore,
    reasons,
    entryBias: 'market_or_limit' as const,
    entryZone: { min: close - (atrValue * 0.2), max: close + (atrValue * 0.2) },
    stopLoss,
    takeProfit,
    riskReward,
  };
}

export function analyzeSignal(input: AnalysisInput): AnalysisSignal {
  const config = input.config ?? DEFAULT_ANALYSIS_CONFIG;
  const entryCandles = input.entryCandles;
  const confirmCandles = input.confirmCandles;
  const biasCandles = input.biasCandles;
  const latestEntry = entryCandles.at(-1);

  if (!latestEntry || entryCandles.length < 60 || confirmCandles.length < 30 || biasCandles.length < 55) {
    return {
      symbol: input.symbol,
      exchange: input.exchange,
      timestamp: input.latest.ts,
      timeframe: config.timeframes.entry,
      regime: 'sideways',
      setupType: null,
      score: 0,
      direction: null,
      entryBias: null,
      entryZone: null,
      stopLoss: null,
      takeProfit: null,
      riskReward: null,
      indicators: {
        emaFast: 0, emaSlow: 0, emaTrend: 0, rsi: 50, macdLine: 0, macdSignal: 0, macdHistogram: 0, vwap: 0, atr: 0, atrPct: 0, volumeRatio: 0, spreadPct: spreadPctFromSnapshot(input.latest),
      },
      reasons: [],
      rejectReasons: ['analysis warmup incomplete'],
      rejected: true,
      confidence: 0,
    };
  }

  const entryCloses = entryCandles.map((bar) => bar.close);
  const confirmCloses = confirmCandles.map((bar) => bar.close);
  const biasCloses = biasCandles.map((bar) => bar.close);
  const emaFastSeries = ema(entryCloses, config.indicators.emaFast);
  const emaSlowSeries = ema(entryCloses, config.indicators.emaSlow);
  const emaTrendSeries = ema(biasCloses, config.indicators.emaTrend);
  const emaFastValue = emaFastSeries.at(-1) ?? latestEntry.close;
  const emaSlowValue = emaSlowSeries.at(-1) ?? latestEntry.close;
  const emaTrendValue = emaTrendSeries.at(-1) ?? latestEntry.close;
  const entryRsi = rsi(entryCloses, config.indicators.rsiLength);
  const prevEntryRsi = rsi(entryCloses.slice(0, -1), config.indicators.rsiLength);
  const macdState = macd(entryCloses, config.indicators.macdFast, config.indicators.macdSlow, config.indicators.macdSignal);
  const atrValue = atr(entryCandles, config.indicators.atrLength);
  const atrPct = latestEntry.close > 0 ? (atrValue / latestEntry.close) * 100 : 0;
  const vwap = intradayVwap(entryCandles);
  const avgVol = averageVolume(entryCandles.slice(0, -1), config.indicators.volumeLookback);
  const volumeRatio = avgVol > 0 ? latestEntry.volume / avgVol : 0;
  const spreadPct = spreadPctFromSnapshot(input.latest);
  const recentStructure = entryCandles.slice(-12, -1);
  const recentHigh = Math.max(...recentStructure.map((bar) => bar.high));
  const recentLow = Math.min(...recentStructure.map((bar) => bar.low));
  const confirmEmaFast = ema(confirmCloses, config.indicators.emaFast).at(-1) ?? latestEntry.close;
  const confirmEmaSlow = ema(confirmCloses, config.indicators.emaSlow).at(-1) ?? latestEntry.close;
  const confirmBull = confirmEmaFast > confirmEmaSlow;
  const confirmBear = confirmEmaFast < confirmEmaSlow;
  const biasBull = latestEntry.close > emaTrendValue;
  const biasBear = latestEntry.close < emaTrendValue;

  const regime = classifyRegime(latestEntry.close, emaFastValue, emaSlowValue, vwap, atrPct, volumeRatio, recentHigh, recentLow);
  const rejectReasons: string[] = [];
  if (spreadPct > config.thresholds.maxSpreadPct) rejectReasons.push(`spread ${spreadPct.toFixed(3)}% > ${config.thresholds.maxSpreadPct}%`);
  if (atrPct < config.thresholds.minAtrPct) rejectReasons.push(`atr ${atrPct.toFixed(3)}% < ${config.thresholds.minAtrPct}%`);
  if (volumeRatio < config.thresholds.minVolumeRatio) rejectReasons.push(`volume ratio ${volumeRatio.toFixed(2)} < ${config.thresholds.minVolumeRatio}`);
  if (input.cooldownActive) rejectReasons.push('cooldown active');
  if (input.killSwitchActive) rejectReasons.push('kill switch active');

  const candidates = [];

  let longTrendScore = 0;
  const longTrendReasons: string[] = [];
  if (biasBull) { longTrendScore += 25; longTrendReasons.push('Higher timeframe bullish bias'); }
  if (emaFastValue > emaSlowValue && latestEntry.close > emaFastValue && latestEntry.close > emaSlowValue) { longTrendScore += 25; longTrendReasons.push('EMA trend aligned'); }
  if (latestEntry.close > vwap) { longTrendScore += 20; longTrendReasons.push('Price above VWAP'); }
  if (entryRsi >= 35 && entryRsi <= 55 && entryRsi > prevEntryRsi) { longTrendScore += 10; longTrendReasons.push('RSI pullback recovered'); }
  if (macdState.histogram > macdState.prevHistogram && macdState.line >= macdState.signal) { longTrendScore += 20; longTrendReasons.push('MACD histogram rising'); }
  if (volumeRatio >= config.thresholds.minVolumeRatio) { longTrendScore += 10; longTrendReasons.push('Volume above average'); }
  if (spreadPct <= config.thresholds.maxSpreadPct) { longTrendScore += 5; longTrendReasons.push('Spread acceptable'); }
  if (['uptrend', 'breakout_expansion'].includes(regime) && confirmBull) {
    candidates.push(buildCandidate('long', 'long_trend_continuation', latestEntry.close, atrValue, longTrendScore, longTrendReasons, config.risk));
  }

  let shortTrendScore = 0;
  const shortTrendReasons: string[] = [];
  if (biasBear) { shortTrendScore += 25; shortTrendReasons.push('Higher timeframe bearish bias'); }
  if (emaFastValue < emaSlowValue && latestEntry.close < emaFastValue && latestEntry.close < emaSlowValue) { shortTrendScore += 25; shortTrendReasons.push('EMA trend aligned'); }
  if (latestEntry.close < vwap) { shortTrendScore += 20; shortTrendReasons.push('Price below VWAP'); }
  if (entryRsi >= 45 && entryRsi <= 65 && entryRsi < prevEntryRsi) { shortTrendScore += 10; shortTrendReasons.push('RSI rally fading'); }
  if (macdState.histogram < macdState.prevHistogram && macdState.line <= macdState.signal) { shortTrendScore += 20; shortTrendReasons.push('MACD histogram falling'); }
  if (volumeRatio >= config.thresholds.minVolumeRatio) { shortTrendScore += 10; shortTrendReasons.push('Volume above average'); }
  if (spreadPct <= config.thresholds.maxSpreadPct) { shortTrendScore += 5; shortTrendReasons.push('Spread acceptable'); }
  if (['downtrend', 'breakout_expansion'].includes(regime) && confirmBear) {
    candidates.push(buildCandidate('short', 'short_trend_continuation', latestEntry.close, atrValue, shortTrendScore, shortTrendReasons, config.risk));
  }

  let longMeanScore = 0;
  const longMeanReasons: string[] = [];
  if (!biasBear) { longMeanScore += 20; longMeanReasons.push('Higher timeframe not bearish'); }
  if (entryRsi < 35 || (entryRsi >= 35 && entryRsi <= 45 && entryRsi > prevEntryRsi)) { longMeanScore += 20; longMeanReasons.push('RSI oversold/pullback recovery'); }
  if (macdState.histogram > macdState.prevHistogram) { longMeanScore += 15; longMeanReasons.push('Seller momentum decelerating'); }
  if (latestEntry.close >= vwap || latestEntry.close > (entryCandles.at(-2)?.high ?? latestEntry.close)) { longMeanScore += 20; longMeanReasons.push('Reclaim trigger confirmed'); }
  if (atrPct >= config.thresholds.minAtrPct) { longMeanScore += 10; longMeanReasons.push('ATR tradeable'); }
  if (volumeRatio >= config.thresholds.minVolumeRatio) { longMeanScore += 10; longMeanReasons.push('Volume supports reversal'); }
  if (spreadPct <= config.thresholds.maxSpreadPct) { longMeanScore += 5; longMeanReasons.push('Spread acceptable'); }
  if (['sideways', 'uptrend'].includes(regime)) {
    candidates.push(buildCandidate('long', 'long_mean_reversion', latestEntry.close, atrValue, longMeanScore, longMeanReasons, config.risk));
  }

  let shortMeanScore = 0;
  const shortMeanReasons: string[] = [];
  if (!biasBull) { shortMeanScore += 20; shortMeanReasons.push('Higher timeframe not bullish'); }
  if (entryRsi > 65 || (entryRsi >= 55 && entryRsi <= 65 && entryRsi < prevEntryRsi)) { shortMeanScore += 20; shortMeanReasons.push('RSI overbought/reversal'); }
  if (macdState.histogram < macdState.prevHistogram) { shortMeanScore += 15; shortMeanReasons.push('Buyer momentum decelerating'); }
  if (latestEntry.close <= vwap || latestEntry.close < (entryCandles.at(-2)?.low ?? latestEntry.close)) { shortMeanScore += 20; shortMeanReasons.push('Rejection trigger confirmed'); }
  if (atrPct >= config.thresholds.minAtrPct) { shortMeanScore += 10; shortMeanReasons.push('ATR tradeable'); }
  if (volumeRatio >= config.thresholds.minVolumeRatio) { shortMeanScore += 10; shortMeanReasons.push('Volume supports reversal'); }
  if (spreadPct <= config.thresholds.maxSpreadPct) { shortMeanScore += 5; shortMeanReasons.push('Spread acceptable'); }
  if (['sideways', 'downtrend'].includes(regime)) {
    candidates.push(buildCandidate('short', 'short_mean_reversion', latestEntry.close, atrValue, shortMeanScore, shortMeanReasons, config.risk));
  }

  const brokeOut = latestEntry.close > recentHigh && volumeRatio >= 1.2 && atrPct >= Math.max(config.thresholds.minAtrPct, 0.35);
  if (brokeOut) {
    candidates.push(buildCandidate('long', 'breakout', latestEntry.close, atrValue, 85, [
      'Compression/range resolved upward',
      'ATR expanding',
      'Volume expansion confirmed',
      'Price broke local structure',
    ], config.risk));
  }
  const brokeDown = latestEntry.close < recentLow && volumeRatio >= 1.2 && atrPct >= Math.max(config.thresholds.minAtrPct, 0.35);
  if (brokeDown) {
    candidates.push(buildCandidate('short', 'breakdown', latestEntry.close, atrValue, 85, [
      'Compression/range resolved downward',
      'ATR expanding',
      'Volume expansion confirmed',
      'Price broke local structure',
    ], config.risk));
  }

  const best = candidates.sort((a, b) => b.score - a.score)[0] ?? null;
  const rejected = rejectReasons.length > 0 || !best || best.score < config.thresholds.minScore || (regime === 'sideways' && best.direction === 'long' && best.score < config.thresholds.strongBuyScoreInSideways);
  if (best && regime === 'sideways' && best.direction === 'long' && best.score < config.thresholds.strongBuyScoreInSideways) {
    rejectReasons.push(`sideways regime requires score >= ${config.thresholds.strongBuyScoreInSideways}`);
  }
  if (best && best.score < config.thresholds.minScore) {
    rejectReasons.push(`score ${best.score} < ${config.thresholds.minScore}`);
  }
  if (!best) rejectReasons.push('no valid setup');

  return {
    symbol: input.symbol,
    exchange: input.exchange,
    timestamp: input.latest.ts,
    timeframe: config.timeframes.entry,
    regime,
    setupType: best?.setupType ?? null,
    score: best?.score ?? 0,
    direction: best?.direction ?? null,
    entryBias: best?.entryBias ?? null,
    entryZone: best?.entryZone ?? null,
    stopLoss: best?.stopLoss ?? null,
    takeProfit: best?.takeProfit ?? null,
    riskReward: best?.riskReward ?? null,
    indicators: {
      emaFast: emaFastValue,
      emaSlow: emaSlowValue,
      emaTrend: emaTrendValue,
      rsi: entryRsi,
      macdLine: macdState.line,
      macdSignal: macdState.signal,
      macdHistogram: macdState.histogram,
      vwap,
      atr: atrValue,
      atrPct,
      volumeRatio,
      spreadPct,
    },
    reasons: best?.reasons ?? [],
    rejectReasons,
    rejected,
    confidence: Math.max(0, Math.min(1, (best?.score ?? 0) / 100)),
  };
}
