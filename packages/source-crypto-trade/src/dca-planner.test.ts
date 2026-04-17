import { describe, it, expect } from 'vitest';
import { decideDcaBuys, type DcaPlannerInput } from './dca-planner.js';
import type { DcaConfig } from './dca-config.js';

const baseConfig: DcaConfig = {
  enabled: true,
  totalAllocationPct: 10,
  maxCoins: 3,
  coins: ['BTC', 'ETH', 'SOL'],
  exchanges: ['kraken', 'coinbase', 'binance-us', 'gemini'],
  intervalMs: 86_400_000, // 24h
};

const baseInput = (over: Partial<DcaPlannerInput> = {}): DcaPlannerInput => ({
  config: baseConfig,
  now: 0,
  equityUsd: 1000,
  currentHoldings: new Map(),
  lastBuyAt: new Map(),
  isEligible: () => true,
  ...over,
});

describe('decideDcaBuys', () => {
  it('returns empty when disabled', () => {
    const buys = decideDcaBuys(baseInput({ config: { ...baseConfig, enabled: false } }));
    expect(buys).toEqual([]);
  });

  it('returns empty when equity is zero', () => {
    expect(decideDcaBuys(baseInput({ equityUsd: 0 }))).toEqual([]);
  });

  it('plans max coins × exchanges buys on a fresh state (first run)', () => {
    const buys = decideDcaBuys(baseInput());
    // 4 exchanges × 3 coins = 12 buys, all on first run
    expect(buys.length).toBe(12);
  });

  it('sizes each buy at (equity × perExchangePct/100) / maxCoins', () => {
    const buys = decideDcaBuys(baseInput());
    // 10% total / 4 exchanges = 2.5% per exchange of $1000 = $25, split
    // across 3 coins = $8.333 per buy
    for (const b of buys) {
      expect(b.usdAmount).toBeCloseTo(1000 * (10 / 4) / 100 / 3, 5);
    }
  });

  it('skips (exchange, coin) inside the interval window', () => {
    const lastBuyAt = new Map([['kraken:BTC', 1000]]);
    const buys = decideDcaBuys(baseInput({ now: 1000 + 60_000, lastBuyAt }));
    // kraken:BTC is 60s old vs 24h interval → suppressed; rest still fire
    expect(buys.find((b) => b.exchange === 'kraken' && b.coin === 'BTC')).toBeUndefined();
    expect(buys.length).toBe(11);
  });

  it('allows re-buy exactly at the interval boundary', () => {
    const lastBuyAt = new Map([['kraken:BTC', 0]]);
    const buys = decideDcaBuys(baseInput({ now: baseConfig.intervalMs, lastBuyAt }));
    expect(buys.find((b) => b.exchange === 'kraken' && b.coin === 'BTC')).toBeDefined();
  });

  it('respects maxCoins cap when exchange already holds other coins', () => {
    const currentHoldings = new Map([
      ['kraken', new Set(['DOGE', 'ADA', 'LINK'])], // already at 3 slots
    ]);
    const buys = decideDcaBuys(baseInput({ currentHoldings }));
    // Kraken is full — no DCA buys on that venue
    expect(buys.filter((b) => b.exchange === 'kraken')).toEqual([]);
    // Other exchanges still get all 3
    expect(buys.filter((b) => b.exchange === 'coinbase').length).toBe(3);
  });

  it('allows a top-up on a coin already held (doesn\'t consume a new slot)', () => {
    const currentHoldings = new Map([
      ['kraken', new Set(['BTC', 'ETH', 'SOL'])], // already holding all 3 DCA coins
    ]);
    const buys = decideDcaBuys(baseInput({ currentHoldings }));
    // Kraken top-ups all 3 (no new slots needed)
    expect(buys.filter((b) => b.exchange === 'kraken').length).toBe(3);
  });

  it('skips coins that fail the eligibility screen', () => {
    const isEligible = (_ex: string, coin: string) => coin !== 'SOL';
    const buys = decideDcaBuys(baseInput({ isEligible }));
    expect(buys.find((b) => b.coin === 'SOL')).toBeUndefined();
    // 4 × 2 = 8 buys (BTC + ETH only)
    expect(buys.length).toBe(8);
  });

  it('ignores coins on exchanges not in config', () => {
    const config: DcaConfig = { ...baseConfig, exchanges: ['kraken'] };
    const buys = decideDcaBuys(baseInput({ config }));
    expect(new Set(buys.map((b) => b.exchange))).toEqual(new Set(['kraken']));
    // Per-exchange % when only 1 exchange = 10%; full 10% bucket split 3 coins
    for (const b of buys) {
      expect(b.usdAmount).toBeCloseTo(1000 * 10 / 100 / 3, 5);
    }
  });

  it('enforces maxCoins across queued + held combined', () => {
    const config: DcaConfig = { ...baseConfig, coins: ['BTC', 'ETH', 'SOL', 'ADA'], maxCoins: 2 };
    const currentHoldings = new Map([['kraken', new Set(['BTC'])]]); // 1 slot used
    const buys = decideDcaBuys(baseInput({ config, currentHoldings }));
    const krakenBuys = buys.filter((b) => b.exchange === 'kraken');
    // Held: BTC. Can add one more → BTC (top-up, no new slot) + ETH (1 new slot hits cap).
    // SOL/ADA should be skipped because cap was reached after ETH.
    const coinsBought = krakenBuys.map((b) => b.coin);
    expect(coinsBought).toContain('BTC');
    expect(coinsBought).toContain('ETH');
    expect(coinsBought).not.toContain('SOL');
    expect(coinsBought).not.toContain('ADA');
  });
});
