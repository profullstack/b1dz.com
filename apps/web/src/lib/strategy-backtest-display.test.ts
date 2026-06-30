import { describe, it, expect } from 'vitest';
import {
  type BacktestStrategy,
  visibleHorizons,
  fmtReturnPct,
  fmtWinRate,
} from './strategy-backtest-display';

function strategy(horizons: Partial<BacktestStrategy['horizons'][number]>[]): BacktestStrategy {
  return {
    strategyId: 's',
    name: 'S',
    tagline: 't',
    horizons: horizons.map((h, i) => ({
      label: `h${i}`,
      startYmd: '2025-01-01',
      endYmd: '2026-01-01',
      trades: 0,
      returnPct: 0,
      winRate: 0,
      profit: 0,
      maxDrawdown: 0,
      ...h,
    })),
  };
}

describe('visibleHorizons', () => {
  it('keeps only horizons with at least one trade', () => {
    const s = strategy([{ trades: 0 }, { trades: 3 }, { trades: 0 }, { trades: 12 }]);
    expect(visibleHorizons(s).map((h) => h.trades)).toEqual([3, 12]);
  });

  it('returns empty when nothing traded', () => {
    expect(visibleHorizons(strategy([{ trades: 0 }, { trades: 0 }]))).toEqual([]);
  });
});

describe('fmtReturnPct', () => {
  it('prefixes a plus for non-negative returns', () => {
    expect(fmtReturnPct(0.085)).toBe('+8.5%');
    expect(fmtReturnPct(0)).toBe('+0.0%');
  });
  it('keeps the minus sign for losses', () => {
    expect(fmtReturnPct(-0.0259)).toBe('-2.6%');
  });
});

describe('fmtWinRate', () => {
  it('renders a whole-percent win rate', () => {
    expect(fmtWinRate(0.3803)).toBe('38%');
    expect(fmtWinRate(0.6765)).toBe('68%');
    expect(fmtWinRate(0)).toBe('0%');
  });
});
