import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { dcaConfigFromEnv, perExchangeAllocationPct, DCA_DEFAULTS } from './dca-config.js';

const ENV_KEYS = [
  'DCA_ENABLED', 'DCA_TOTAL_ALLOCATION_PCT', 'DCA_MAX_COINS',
  'DCA_COINS', 'DCA_EXCHANGES', 'DCA_INTERVAL_MS',
];

describe('dcaConfigFromEnv', () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('returns DCA_DEFAULTS when no env is set', () => {
    const c = dcaConfigFromEnv();
    expect(c.enabled).toBe(DCA_DEFAULTS.enabled);
    expect(c.totalAllocationPct).toBe(DCA_DEFAULTS.totalAllocationPct);
    expect(c.maxCoins).toBe(DCA_DEFAULTS.maxCoins);
    expect(c.coins).toEqual([...DCA_DEFAULTS.coins]);
    expect(c.exchanges).toEqual([...DCA_DEFAULTS.exchanges]);
    expect(c.intervalMs).toBe(DCA_DEFAULTS.intervalMs);
  });

  it('reads DCA_ENABLED=false', () => {
    process.env.DCA_ENABLED = 'false';
    expect(dcaConfigFromEnv().enabled).toBe(false);
  });

  it('normalizes DCA_COINS to uppercase + trims whitespace', () => {
    process.env.DCA_COINS = ' btc , eth ,sol ';
    expect(dcaConfigFromEnv().coins).toEqual(['BTC', 'ETH', 'SOL']);
  });

  it('normalizes DCA_EXCHANGES to lowercase', () => {
    process.env.DCA_EXCHANGES = 'Kraken,Binance-US';
    expect(dcaConfigFromEnv().exchanges).toEqual(['kraken', 'binance-us']);
  });

  it('falls back to defaults on invalid numeric input', () => {
    process.env.DCA_MAX_COINS = 'abc';
    expect(dcaConfigFromEnv().maxCoins).toBe(DCA_DEFAULTS.maxCoins);
  });

  it('clamps maxCoins to at least 1', () => {
    process.env.DCA_MAX_COINS = '0';
    expect(dcaConfigFromEnv().maxCoins).toBe(DCA_DEFAULTS.maxCoins);
  });
});

describe('perExchangeAllocationPct', () => {
  it('splits total evenly across exchanges', () => {
    const c = dcaConfigFromEnv();
    expect(perExchangeAllocationPct(c)).toBeCloseTo(10 / 4);
  });

  it('returns 0 when disabled', () => {
    const c = { ...dcaConfigFromEnv(), enabled: false };
    expect(perExchangeAllocationPct(c)).toBe(0);
  });

  it('returns 0 when exchange list is empty', () => {
    const c = { ...dcaConfigFromEnv(), exchanges: [] };
    expect(perExchangeAllocationPct(c)).toBe(0);
  });
});
