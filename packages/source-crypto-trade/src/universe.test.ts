import { afterEach, describe, expect, it } from 'vitest';
import { isMomentumEntry, isTradablePair, scanPairs, tradeUniverse } from './universe.js';
import type { AnalysisSignal } from './analysis/engine.js';

const saved = process.env.TRADE_UNIVERSE;
afterEach(() => {
  if (saved === undefined) delete process.env.TRADE_UNIVERSE;
  else process.env.TRADE_UNIVERSE = saved;
});

describe('trade universe', () => {
  it('allows large caps and rejects meme coins, small caps and stables by default', () => {
    delete process.env.TRADE_UNIVERSE;
    for (const p of ['BTC-USD', 'ETH-USD', 'SOL-USD', 'XRP-USD', 'LINK-USD']) expect(isTradablePair(p)).toBe(true);
    for (const p of ['DOGE-USD', 'BONK-USD', 'WIF-USD', 'PEPE-USD', 'FARTCOIN-USD', 'RAVE-USD', 'USDC-USD']) expect(isTradablePair(p)).toBe(false);
  });

  it('TRADE_UNIVERSE replaces the list but cannot re-admit a blocked meme coin', () => {
    process.env.TRADE_UNIVERSE = 'BTC, eth, DOGE';
    expect(isTradablePair('BTC-USD')).toBe(true);
    expect(isTradablePair('ETH-USD')).toBe(true);
    expect(isTradablePair('SOL-USD')).toBe(false);
    expect(isTradablePair('DOGE-USD')).toBe(false);
  });

  it('TRADE_UNIVERSE=all drops the allowlist but keeps the blocklist', () => {
    process.env.TRADE_UNIVERSE = 'all';
    expect(tradeUniverse()).toBeNull();
    expect(isTradablePair('RAVE-USD')).toBe(true);
    expect(isTradablePair('SHIB-USD')).toBe(false);
  });

  it('scanPairs keeps held pairs outside the universe so their exits run', () => {
    delete process.env.TRADE_UNIVERSE;
    expect(scanPairs(['BTC-USD', 'BONK-USD', 'ETH-USD', 'RAVE-USD'], ['RAVE-USD'])).toEqual(['BTC-USD', 'ETH-USD', 'RAVE-USD']);
  });
});

describe('momentum entries', () => {
  const sig = (over: Partial<AnalysisSignal>) => ({ rejected: false, direction: 'long', setupType: 'breakout', ...over }) as AnalysisSignal;
  it('accepts trend continuation and breakout longs only', () => {
    expect(isMomentumEntry(sig({ setupType: 'breakout' }))).toBe(true);
    expect(isMomentumEntry(sig({ setupType: 'long_trend_continuation' }))).toBe(true);
    expect(isMomentumEntry(sig({ setupType: 'long_mean_reversion' }))).toBe(false);
    expect(isMomentumEntry(sig({ direction: 'short', setupType: 'breakdown' }))).toBe(false);
    expect(isMomentumEntry(sig({ rejected: true }))).toBe(false);
    expect(isMomentumEntry(null)).toBe(false);
  });
});
