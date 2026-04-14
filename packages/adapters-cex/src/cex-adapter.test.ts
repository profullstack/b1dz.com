import { describe, expect, it } from 'vitest';
import type { PriceFeed, MarketSnapshot } from '@b1dz/core';
import { CexAdapter, CEX_TAKER_FEES } from './cex-adapter.js';

class StubFeed implements PriceFeed {
  exchange: string;
  private snap: MarketSnapshot | null;
  constructor(exchange: string, snap: MarketSnapshot | null) {
    this.exchange = exchange;
    this.snap = snap;
  }
  async snapshot(): Promise<MarketSnapshot | null> {
    return this.snap;
  }
}

function mkSnap(overrides: Partial<MarketSnapshot>): MarketSnapshot {
  return {
    exchange: 'kraken',
    pair: 'SOL-USD',
    bid: 100,
    ask: 100.1,
    bidSize: 10,
    askSize: 10,
    ts: Date.now(),
    ...overrides,
  };
}

describe('CexAdapter', () => {
  it('returns null when the feed has no snapshot for the pair', async () => {
    const adapter = new CexAdapter(new StubFeed('kraken', null));
    const q = await adapter.quote({ pair: 'FAKE-USD', side: 'sell', amountIn: '1' });
    expect(q).toBeNull();
  });

  it('quotes sell at the bid and applies the exchange taker fee', async () => {
    const feed = new StubFeed('kraken', mkSnap({ bid: 100, ask: 100.1 }));
    const adapter = new CexAdapter(feed);
    const q = await adapter.quote({ pair: 'SOL-USD', side: 'sell', amountIn: '1' });
    expect(q).not.toBeNull();
    expect(Number.parseFloat(q!.amountOut)).toBe(100);
    // Fee = 100 USD × 0.26% = $0.26
    expect(q!.feeUsd).toBeCloseTo(0.26, 5);
    expect(q!.gasUsd).toBe(0);
    expect(q!.venue).toBe('kraken');
  });

  it('quotes buy at the ask and charges fee on the USD notional spent', async () => {
    const feed = new StubFeed('kraken', mkSnap({ bid: 100, ask: 101 }));
    const adapter = new CexAdapter(feed);
    const q = await adapter.quote({ pair: 'SOL-USD', side: 'buy', amountIn: '101' });
    expect(q).not.toBeNull();
    // amountOut = 101 / 101 = 1 SOL
    expect(Number.parseFloat(q!.amountOut)).toBeCloseTo(1, 5);
    // Fee = 101 × 0.26% = 0.2626
    expect(q!.feeUsd).toBeCloseTo(0.2626, 4);
  });

  it('adds simulated slippage when amount exceeds top-of-book depth', async () => {
    // 10 SOL bid depth, but we sell 100 SOL — should incur slippage.
    const feed = new StubFeed('kraken', mkSnap({ bid: 100, ask: 100.1, bidSize: 10 }));
    const adapter = new CexAdapter(feed);
    const q = await adapter.quote({ pair: 'SOL-USD', side: 'sell', amountIn: '100' });
    expect(q).not.toBeNull();
    expect(q!.slippageBps).toBeGreaterThan(0);
    // Each extra top-of-book adds ~5 bps; excess ratio = 9, so ~45 bps.
    expect(q!.slippageBps).toBeLessThanOrEqual(1000);
  });

  it('uses feeRate override when provided', async () => {
    const feed = new StubFeed('kraken', mkSnap({ bid: 100 }));
    const adapter = new CexAdapter(feed, { feeRate: 0 });
    const q = await adapter.quote({ pair: 'SOL-USD', side: 'sell', amountIn: '1' });
    expect(q!.feeUsd).toBe(0);
  });

  it('CEX_TAKER_FEES matches the live daemon constants', () => {
    expect(CEX_TAKER_FEES.kraken).toBe(0.0026);
    expect(CEX_TAKER_FEES['binance-us']).toBe(0.001);
    expect(CEX_TAKER_FEES.coinbase).toBe(0.006);
    expect(CEX_TAKER_FEES.gemini).toBe(0.004);
  });
});
