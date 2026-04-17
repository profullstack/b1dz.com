import { describe, it, expect } from 'vitest';
import { CexCexExecutor } from './cex-cex.js';
import type { Opportunity } from '@b1dz/venue-types';

function mkOpp(over: Partial<Opportunity> = {}): Opportunity {
  return {
    id: 'test-1',
    buyVenue: 'binance-us',
    sellVenue: 'gemini',
    buyChain: null,
    sellChain: null,
    asset: 'BTC',
    size: '10',
    grossEdgeUsd: 0.5,
    totalFeesUsd: 0.1,
    totalGasUsd: 0,
    totalSlippageUsd: 0.05,
    riskBufferUsd: 0.02,
    expectedNetUsd: 0.33,
    expectedNetBps: 33,
    confidence: 0.9,
    blockers: [],
    executable: true,
    category: 'cex_cex',
    buyQuote: { price: '100', amountIn: '10', amountOut: '0.1' } as never,
    sellQuote: { price: '100.5', amountIn: '0.1', amountOut: '10.05' } as never,
    observedAt: Date.now(),
    ...over,
  };
}

describe('CexCexExecutor.canExecute', () => {
  const exec = new CexCexExecutor({ maxTradeUsd: 100 });

  it('accepts any permutation of the 4 CEXes', () => {
    const venues = ['kraken', 'coinbase', 'binance-us', 'gemini'];
    for (const buy of venues) {
      for (const sell of venues) {
        if (buy === sell) continue;
        expect(exec.canExecute(mkOpp({ buyVenue: buy, sellVenue: sell }))).toBe(true);
      }
    }
  });

  it('rejects non-cex_cex category', () => {
    expect(exec.canExecute(mkOpp({ category: 'cex_dex' }))).toBe(false);
  });

  it('rejects unknown venues', () => {
    expect(exec.canExecute(mkOpp({ buyVenue: 'ftx' }))).toBe(false);
    expect(exec.canExecute(mkOpp({ sellVenue: 'bitmex' }))).toBe(false);
  });

  it('rejects same-venue opportunities', () => {
    expect(exec.canExecute(mkOpp({ buyVenue: 'kraken', sellVenue: 'kraken' }))).toBe(false);
  });
});

describe('CexCexExecutor.execute', () => {
  const exec = new CexCexExecutor({ maxTradeUsd: 5, log: () => {} });

  it('aborts when size exceeds maxTradeUsd', async () => {
    const outcome = await exec.execute(mkOpp({ size: '10' })); // cap is $5
    expect(outcome.status).toBe('aborted');
    expect(outcome.resolvedReason).toMatch(/executor cap/);
    expect(outcome.executorRan).toBe(false);
  });

  it('aborts on invalid size', async () => {
    const outcome = await exec.execute(mkOpp({ size: 'abc' }));
    expect(outcome.status).toBe('aborted');
    expect(outcome.resolvedReason).toMatch(/invalid size/);
  });

  it('aborts when quote prices are missing', async () => {
    const outcome = await exec.execute(mkOpp({
      size: '1',
      buyQuote: {} as never,
      sellQuote: {} as never,
    }));
    expect(outcome.status).toBe('aborted');
    expect(outcome.resolvedReason).toMatch(/quote price/);
  });
});
