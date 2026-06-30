import { describe, it, expect } from 'vitest';
import { parseArgs } from './strategy-backtest.js';

describe('strategy-backtest parseArgs', () => {
  it('defaults to backtesting both asset classes', () => {
    expect(parseArgs(['mean-reversion']).classes).toEqual(['crypto', 'equity']);
  });

  it('restricts to crypto with --crypto', () => {
    expect(parseArgs(['all', '--crypto']).classes).toEqual(['crypto']);
  });

  it('restricts to equities with --equities (or --equity)', () => {
    expect(parseArgs(['all', '--equities']).classes).toEqual(['equity']);
    expect(parseArgs(['all', '--equity']).classes).toEqual(['equity']);
  });

  it('falls back to both when both flags are passed', () => {
    expect(parseArgs(['all', '--crypto', '--equities']).classes).toEqual(['crypto', 'equity']);
  });

  it('reads the strategy selector positionally or via --strategy', () => {
    expect(parseArgs(['breakout']).selector).toBe('breakout');
    expect(parseArgs(['--strategy', 'breakout']).selector).toBe('breakout');
    expect(parseArgs([]).selector).toBeNull();
  });

  it('reads a TSP file path and per-entry amount', () => {
    const a = parseArgs(['--file', 'my.tsp.json', '--amount', '250']);
    expect(a.file).toBe('my.tsp.json');
    expect(a.amount).toBe(250);
  });

  it('defaults amount to 100 and clamps to >= 1', () => {
    expect(parseArgs(['all']).amount).toBe(100);
    expect(parseArgs(['all', '--amount', '0']).amount).toBe(1);
  });
});
