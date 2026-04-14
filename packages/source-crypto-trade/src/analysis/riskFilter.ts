import type { AnalysisConfig } from './config.js';
import type { MarketRegime, SetupType } from './engine.js';

export interface RiskFilterIndicators {
  atrPct: number;
  volumeRatio: number;
  spreadPct: number;
  /** Projected target distance as % of entry price (ATR% × target ATR multiple) */
  targetPct?: number;
}

export interface ScoredCandidate {
  direction: 'long' | 'short';
  setupType: SetupType;
  score: number;
}

export interface RiskFilterInput {
  regime: MarketRegime;
  candidate: ScoredCandidate | null;
  indicators: RiskFilterIndicators;
  cooldownActive?: boolean;
  killSwitchActive?: boolean;
  config: AnalysisConfig;
}

export interface RiskFilterResult {
  rejected: boolean;
  rejectReasons: string[];
}

export function applyRiskFilters(input: RiskFilterInput): RiskFilterResult {
  const rejectReasons: string[] = [];
  const { config, indicators, candidate, regime } = input;

  if (indicators.spreadPct > config.thresholds.maxSpreadPct) {
    rejectReasons.push(`spread ${indicators.spreadPct.toFixed(3)}% > ${config.thresholds.maxSpreadPct}%`);
  }
  if (indicators.atrPct < config.thresholds.minAtrPct) {
    rejectReasons.push(`atr ${indicators.atrPct.toFixed(3)}% < ${config.thresholds.minAtrPct}%`);
  }
  if (indicators.volumeRatio < config.thresholds.minVolumeRatio) {
    rejectReasons.push(`volume ratio ${indicators.volumeRatio.toFixed(2)} < ${config.thresholds.minVolumeRatio}`);
  }
  if (input.cooldownActive) rejectReasons.push('cooldown active');
  if (input.killSwitchActive) rejectReasons.push('kill switch active');

  if (!candidate) {
    rejectReasons.push('no valid setup');
    return { rejected: true, rejectReasons };
  }

  if (candidate.score < config.thresholds.minScore) {
    rejectReasons.push(`score ${candidate.score} < ${config.thresholds.minScore}`);
  }
  if (regime === 'sideways' && candidate.direction === 'long' && candidate.score < config.thresholds.strongBuyScoreInSideways) {
    rejectReasons.push(`sideways regime requires score >= ${config.thresholds.strongBuyScoreInSideways}`);
  }

  // Fee-clearance guard: require target distance to clear round-trip fees by a
  // configured margin. Without this, a 0.3% ATR × 2.5 target = 0.75% target,
  // which on a 0.6% taker fee (1.2% round-trip) is negative EV on every fill.
  if (typeof indicators.targetPct === 'number') {
    const roundTripFeePct = 2 * config.risk.assumedFeeRate * 100;
    const minTargetPct = roundTripFeePct * config.thresholds.minTargetPctOverFees;
    if (indicators.targetPct < minTargetPct) {
      rejectReasons.push(`target ${indicators.targetPct.toFixed(3)}% < ${minTargetPct.toFixed(3)}% (${config.thresholds.minTargetPctOverFees}× round-trip fee)`);
    }
  }

  return {
    rejected: rejectReasons.length > 0,
    rejectReasons,
  };
}
