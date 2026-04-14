import { describe, expect, it } from 'vitest';
import { DEFAULT_ANALYSIS_CONFIG } from './config.js';
import { applyRiskFilters } from './riskFilter.js';

describe('risk filter contract', () => {
  it('rejects when spread exceeds threshold', () => {
    const result = applyRiskFilters({
      regime: 'uptrend',
      candidate: { direction: 'long', setupType: 'long_trend_continuation', score: 84 },
      indicators: { atrPct: 0.5, volumeRatio: 1.4, spreadPct: 0.5 },
      config: DEFAULT_ANALYSIS_CONFIG,
    });

    expect(result.rejected).toBe(true);
    expect(result.rejectReasons.some((reason) => reason.includes('spread'))).toBe(true);
  });

  it('rejects weak sideways long setups even with an otherwise valid candidate', () => {
    const result = applyRiskFilters({
      regime: 'sideways',
      candidate: { direction: 'long', setupType: 'long_mean_reversion', score: 70 },
      indicators: { atrPct: 0.4, volumeRatio: 1.2, spreadPct: 0.04 },
      config: DEFAULT_ANALYSIS_CONFIG,
    });

    expect(result.rejected).toBe(true);
    expect(result.rejectReasons.some((reason) => reason.includes('sideways regime'))).toBe(true);
  });

  it('passes a strong candidate when all risk filters are satisfied', () => {
    const result = applyRiskFilters({
      regime: 'uptrend',
      candidate: { direction: 'long', setupType: 'long_trend_continuation', score: 84 },
      indicators: { atrPct: 0.4, volumeRatio: 1.3, spreadPct: 0.04 },
      config: DEFAULT_ANALYSIS_CONFIG,
    });

    expect(result.rejected).toBe(false);
    expect(result.rejectReasons).toEqual([]);
  });
});
