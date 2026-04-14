export const DEFAULT_ANALYSIS_CONFIG = {
  timeframes: {
    entry: '5m',
    confirm: '15m',
    bias: '1h',
  },
  indicators: {
    emaFast: 9,
    emaSlow: 21,
    emaTrend: 50,
    rsiLength: 14,
    atrLength: 14,
    macdFast: 12,
    macdSlow: 26,
    macdSignal: 9,
    volumeLookback: 20,
  },
  thresholds: {
    minScore: 75,
    highConfidenceScore: 80,
    strongBuyScoreInSideways: 85,
    maxSpreadPct: 0.15,
    minVolumeRatio: 1.1,
    minAtrPct: 0.2,
    minTargetPctOverFees: 1.5,
  },
  risk: {
    defaultAtrStopMultiple: 1.5,
    defaultAtrTargetMultiple: 2.5,
    cooldownBarsAfterLoss: 3,
    assumedFeeRate: 0.003,
  },
} as const;

export type AnalysisConfig = typeof DEFAULT_ANALYSIS_CONFIG;
