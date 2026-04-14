import type { AnalysisConfig } from './config.js';
import type { MarketRegime, SetupType } from './engine.js';

export interface RiskFilterIndicators {
  atrPct: number;
  volumeRatio: number;
  spreadPct: number;
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

  return {
    rejected: rejectReasons.length > 0,
    rejectReasons,
  };
}
