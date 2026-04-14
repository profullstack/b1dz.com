import { describe, expect, it } from 'vitest';
import type { VenueAdapter, QuoteRequest, NormalizedQuote, AdapterHealth } from '@b1dz/venue-types';
import { InMemoryEventChannel } from '@b1dz/event-channel';
import { ObserveEngine, type ObservePair } from './index.js';

function mkQuote(overrides: Partial<NormalizedQuote>): NormalizedQuote {
  return {
    venue: 'test',
    venueType: 'cex',
    chain: null,
    pair: 'ETH-USDC',
    baseAsset: 'ETH',
    quoteAsset: 'USDC',
    amountIn: '1000',
    amountOut: '0.4',
    amountInUsd: 1000,
    amountOutUsd: 1000,
    side: 'buy',
    estimatedUnitPrice: '2500',
    feeUsd: 0,
    gasUsd: 0,
    slippageBps: 0,
    priceImpactBps: null,
    routeHops: 1,
    routeSummary: [],
    quoteTimestamp: Date.now(),
    raw: null,
    ...overrides,
  };
}

class FakeAdapter implements VenueAdapter {
  readonly venueType = 'cex' as const;
  readonly chain = null;
  constructor(
    public readonly venue: string,
    private readonly quoteFn: (req: QuoteRequest) => NormalizedQuote | null,
  ) {}
  async health(): Promise<AdapterHealth> {
    return { ok: true, latencyMs: 1 };
  }
  async supports(): Promise<boolean> {
    return true;
  }
  async quote(req: QuoteRequest): Promise<NormalizedQuote | null> {
    return this.quoteFn(req);
  }
}

const BASIC_PAIR: ObservePair = {
  pair: 'ETH-USDC',
  sizeUsd: 1000,
  baseAmountForSellSide: '0.4',
  quoteAmountForBuySide: '1000',
};

describe('ObserveEngine.tick', () => {
  it('returns zero quotes when no adapters have data', async () => {
    const channel = new InMemoryEventChannel({ uuid: () => 'id' });
    const engine = new ObserveEngine({
      pairs: [BASIC_PAIR],
      adapters: [new FakeAdapter('a', () => null)],
      channel,
    });
    const r = await engine.tick();
    expect(r.quotesFetched).toBe(0);
    expect(r.opportunitiesRanked).toBe(0);
    expect(r.opportunitiesPublished).toBe(0);
    expect(await channel.inspect('pending')).toHaveLength(0);
  });

  it('publishes executable opportunities to the channel', async () => {
    const channel = new InMemoryEventChannel({ uuid: () => `uuid-${Math.random()}` });
    // Adapter A buys ETH cheap (gives 0.402 ETH for 1000 USDC).
    // Adapter B sells ETH expensive (gets 1020 USDC for 0.4 ETH).
    // After profitability engine: gross edge 20 USDC, no fees → executable.
    const adapterA = new FakeAdapter('cheap', (req) => req.side === 'buy'
      ? mkQuote({ venue: 'cheap', side: 'buy', amountIn: '1000', amountOut: '0.402', amountInUsd: 1000, amountOutUsd: 1005 })
      : mkQuote({ venue: 'cheap', side: 'sell', amountIn: '0.4', amountOut: '990', amountInUsd: 1000, amountOutUsd: 990 }));
    const adapterB = new FakeAdapter('rich', (req) => req.side === 'sell'
      ? mkQuote({ venue: 'rich', side: 'sell', amountIn: '0.4', amountOut: '1020', amountInUsd: 1000, amountOutUsd: 1020 })
      : mkQuote({ venue: 'rich', side: 'buy', amountIn: '1000', amountOut: '0.39', amountInUsd: 1000, amountOutUsd: 975 }));
    const engine = new ObserveEngine({
      pairs: [BASIC_PAIR],
      adapters: [adapterA, adapterB],
      channel,
      minNetUsd: 1,
    });
    const r = await engine.tick();
    expect(r.opportunitiesRanked).toBeGreaterThan(0);
    expect(r.opportunitiesPublished).toBeGreaterThan(0);
    const pending = await channel.inspect('pending');
    expect(pending.length).toBeGreaterThan(0);
    // Best route should be buy on cheap, sell on rich.
    const best = pending[0]!;
    expect(best.opportunity.buyVenue).toBe('cheap');
    expect(best.opportunity.sellVenue).toBe('rich');
  });

  it('does not publish non-executable opportunities', async () => {
    const channel = new InMemoryEventChannel({ uuid: () => `uuid-${Math.random()}` });
    // Zero edge, both sides flat.
    const flat = new FakeAdapter('flat', (req) => req.side === 'buy'
      ? mkQuote({ venue: 'flat', side: 'buy', amountIn: '1000', amountOut: '0.4', amountInUsd: 1000, amountOutUsd: 1000 })
      : mkQuote({ venue: 'flat', side: 'sell', amountIn: '0.4', amountOut: '1000', amountInUsd: 1000, amountOutUsd: 1000 }));
    const engine = new ObserveEngine({
      pairs: [BASIC_PAIR],
      adapters: [flat, flat],
      channel,
      minNetUsd: 5,
    });
    const r = await engine.tick();
    expect(r.opportunitiesPublished).toBe(0);
    expect(await channel.inspect('pending')).toHaveLength(0);
  });

  it('respects minNetUsd threshold even on positive gross edges', async () => {
    const channel = new InMemoryEventChannel({ uuid: () => `u-${Math.random()}` });
    // $2 edge. minNetUsd=5 should block.
    const thin = new FakeAdapter('thin-a', (req) => req.side === 'buy'
      ? mkQuote({ venue: 'thin-a', side: 'buy', amountInUsd: 1000, amountOutUsd: 1000, amountIn: '1000', amountOut: '0.4' })
      : mkQuote({ venue: 'thin-a', side: 'sell', amountInUsd: 1000, amountOutUsd: 1002, amountIn: '0.4', amountOut: '1002' }));
    const thin2 = new FakeAdapter('thin-b', (req) => req.side === 'sell'
      ? mkQuote({ venue: 'thin-b', side: 'sell', amountInUsd: 1000, amountOutUsd: 1002, amountIn: '0.4', amountOut: '1002' })
      : mkQuote({ venue: 'thin-b', side: 'buy', amountInUsd: 1000, amountOutUsd: 1000, amountIn: '1000', amountOut: '0.4' }));
    const engine = new ObserveEngine({
      pairs: [BASIC_PAIR],
      adapters: [thin, thin2],
      channel,
      minNetUsd: 5,
    });
    const r = await engine.tick();
    expect(r.opportunitiesRanked).toBeGreaterThan(0);
    expect(r.opportunitiesPublished).toBe(0);
  });

  it('tracks per-venue health metrics across ticks', async () => {
    const channel = new InMemoryEventChannel({ uuid: () => `u-${Math.random()}` });
    let callCount = 0;
    const flaky = new FakeAdapter('flaky', () => {
      callCount++;
      if (callCount % 3 === 0) throw new Error('rpc timeout');
      return mkQuote({ venue: 'flaky', latencyMs: 42 });
    });
    const engine = new ObserveEngine({
      pairs: [BASIC_PAIR],
      adapters: [flaky],
      channel,
    });
    await engine.tick();
    await engine.tick();
    const h = engine.snapshotHealth();
    expect(h[0]!.venue).toBe('flaky');
    expect(h[0]!.okCount).toBeGreaterThan(0);
    expect(h[0]!.errCount).toBeGreaterThan(0);
    expect(h[0]!.lastLatencyMs).toBe(42);
  });

  it('sums quotes across multiple pairs in one tick', async () => {
    const channel = new InMemoryEventChannel({ uuid: () => `u-${Math.random()}` });
    const good = new FakeAdapter('good', (req) => mkQuote({ venue: 'good', pair: req.pair, side: req.side }));
    const engine = new ObserveEngine({
      pairs: [
        BASIC_PAIR,
        { ...BASIC_PAIR, pair: 'BTC-USDC' },
        { ...BASIC_PAIR, pair: 'SOL-USDC' },
      ],
      adapters: [good],
      channel,
    });
    const r = await engine.tick();
    // 3 pairs × 2 sides × 1 adapter = 6 quotes
    expect(r.quotesFetched).toBe(6);
  });

  it('start/stop runs an interval loop', async () => {
    const channel = new InMemoryEventChannel({ uuid: () => `u-${Math.random()}` });
    let ticks = 0;
    const adapter = new FakeAdapter('ticker', () => {
      ticks++;
      return null;
    });
    const engine = new ObserveEngine({
      pairs: [BASIC_PAIR],
      adapters: [adapter],
      channel,
      intervalMs: 10,
      log: () => {},
    });
    engine.start();
    await new Promise((r) => setTimeout(r, 55));
    engine.stop();
    // Initial tick + ~5 interval ticks; each tick fetches both sides = 2 calls.
    // Loose assertion to avoid flakes under load.
    expect(ticks).toBeGreaterThanOrEqual(2);
  });

  it('publish failures do not crash the tick', async () => {
    const brokenChannel: InMemoryEventChannel = new InMemoryEventChannel({ uuid: () => 'u' });
    // Override publish to always throw.
    (brokenChannel as unknown as { publish: () => Promise<never> }).publish = () => {
      throw new Error('channel down');
    };
    const adapterA = new FakeAdapter('cheap', (req) => req.side === 'buy'
      ? mkQuote({ venue: 'cheap', side: 'buy', amountInUsd: 1000, amountOutUsd: 1005, amountIn: '1000', amountOut: '0.402' })
      : mkQuote({ venue: 'cheap', side: 'sell', amountInUsd: 1000, amountOutUsd: 995, amountIn: '0.4', amountOut: '995' }));
    const adapterB = new FakeAdapter('rich', (req) => req.side === 'sell'
      ? mkQuote({ venue: 'rich', side: 'sell', amountInUsd: 1000, amountOutUsd: 1020, amountIn: '0.4', amountOut: '1020' })
      : mkQuote({ venue: 'rich', side: 'buy', amountInUsd: 1000, amountOutUsd: 990, amountIn: '1000', amountOut: '0.4' }));
    const engine = new ObserveEngine({
      pairs: [BASIC_PAIR],
      adapters: [adapterA, adapterB],
      channel: brokenChannel,
      minNetUsd: 1,
      log: () => {},
    });
    // tick() should resolve even though publish throws.
    const r = await engine.tick();
    expect(r.opportunitiesRanked).toBeGreaterThan(0);
  });
});
