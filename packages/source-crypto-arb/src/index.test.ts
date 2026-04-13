/**
 * Pure unit tests for the arbitrage selection logic — no network, no feeds.
 * Constructs synthetic MarketSnapshots and verifies bestArb picks the right
 * (buy, sell) pair and respects the fee model.
 */
import { describe, it, expect } from 'vitest';
import { cryptoArbSource, evaluateArbStrategies, evaluateInventoryArb, evaluateSpreadArb } from './index.js';
import type { MarketSnapshot } from '@b1dz/core';

const snap = (exchange: string, bid: number, ask: number): MarketSnapshot => ({
  exchange, pair: 'BTC-USD', bid, ask, bidSize: 1, askSize: 1, ts: 0,
});

describe('cryptoArbSource.evaluate', () => {
  it('emits an opportunity when a positive-net spread exists', () => {
    // Buy on binance-us at 100, sell on kraken at 110 → ~10% spread, well over fees
    const opp = evaluateSpreadArb(
      { pair: 'BTC-USD', snapshots: [snap('kraken', 110, 111), snap('binance-us', 99, 100)] },
    );
    expect(opp).not.toBeNull();
    expect(opp!.metadata).toMatchObject({ buyExchange: 'binance-us', sellExchange: 'kraken' });
    expect((opp!.metadata as { strategy: string }).strategy).toBe('spread');
    expect(opp!.projectedProfit).toBeGreaterThan(0);
  });

  it('returns null when fees eat the spread', () => {
    // Tiny spread — buy 100, sell 100.10. Gemini fee 0.4% kills it.
    const opp = evaluateSpreadArb(
      { pair: 'BTC-USD', snapshots: [snap('gemini', 100.10, 100.11), snap('binance-us', 99.99, 100)] },
    );
    expect(opp).toBeNull();
  });

  it('returns null when only one exchange has data', () => {
    const opp = evaluateSpreadArb(
      { pair: 'BTC-USD', snapshots: [snap('gemini', 100, 101)] },
    );
    expect(opp).toBeNull();
  });

  it('returns null when a quote contains NaN', () => {
    const opp = evaluateSpreadArb(
      { pair: 'BTC-USD', snapshots: [snap('kraken', 110, 111), snap('binance-us', Number.NaN, Number.NaN)] },
    );
    expect(opp).toBeNull();
  });

  it('emits inventory-arb only when balances support both legs', () => {
    const opp = evaluateInventoryArb(
      { pair: 'BTC-USD', snapshots: [snap('kraken', 110, 111), snap('binance-us', 99, 100)] },
      { state: { krakenBalance: { XXBT: '0.10' }, binanceBalance: { USDC: '1000' } } } as never,
    );
    expect(opp).not.toBeNull();
    expect((opp!.metadata as { strategy: string }).strategy).toBe('inventory-arb');
  });

  it('evaluates both spread and inventory-arb when both are available', () => {
    const opps = evaluateArbStrategies(
      { pair: 'BTC-USD', snapshots: [snap('kraken', 110, 111), snap('binance-us', 99, 100)] },
      { state: { krakenBalance: { XXBT: '0.10' }, binanceBalance: { USDC: '1000' } } } as never,
    );
    expect(opps.map((opp) => (opp.metadata as { strategy: string }).strategy)).toEqual(['spread', 'inventory-arb']);
  });

  it('cryptoArbSource.evaluate falls back to spread when inventory-arb is unavailable', () => {
    const opp = cryptoArbSource.evaluate(
      { pair: 'BTC-USD', snapshots: [snap('kraken', 110, 111), snap('binance-us', 99, 100)] },
      { state: {} } as never,
    );
    expect(opp).not.toBeNull();
    expect((opp!.metadata as { strategy: string }).strategy).toBe('spread');
  });
});
