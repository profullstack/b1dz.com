import { describe, it, expect, vi } from 'vitest';
import type { Address } from 'viem';
import type { EventChannel, QueuedOpportunity } from '@b1dz/event-channel';
import type { Opportunity } from '@b1dz/venue-types';
import { TriangularEngine } from './index.js';

const QUOTER = '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a' as Address;

class FakeChannel implements EventChannel {
  readonly published: Opportunity[] = [];
  async publish(opp: Opportunity): Promise<QueuedOpportunity> {
    this.published.push(opp);
    return {
      queueId: `q-${this.published.length}`,
      status: 'pending',
      claimedBy: null,
      claimedAt: null,
      resolvedAt: null,
      resolvedReason: null,
      createdAt: Date.now(),
      expiresAt: Date.now() + 10_000,
      opportunity: opp,
    };
  }
  async claim(): Promise<QueuedOpportunity[]> { return []; }
  async resolve(): Promise<void> { /* no-op */ }
  async inspect(): Promise<QueuedOpportunity[]> { return []; }
}

/** Quoter mock that yields a fixed out-amount every call. 102 USDC out
 *  for 100 USDC in → +2 USDC edge before gas/slippage. */
function profitableClient() {
  return {
    simulateContract: vi.fn(async () => ({
      result: [102_000_000n, [] as bigint[], [] as number[], 350_000n] as const,
    })),
  };
}

function losingClient() {
  return {
    simulateContract: vi.fn(async () => ({
      result: [99_500_000n, [] as bigint[], [] as number[], 350_000n] as const,
    })),
  };
}

function fixedGasOracle() {
  return {
    getFeeData: vi.fn(async () => ({
      chain: 'base' as const,
      maxFeePerGas: 1_000_000n,
      maxPriorityFeePerGas: 100_000n,
      baseFeePerGas: 900_000n,
      observedAt: 0,
    })),
  };
}

function baseConfig(client: unknown, channel: EventChannel) {
  return {
    chain: 'base' as const,
    client,
    quoter: QUOTER,
    anchor: 'USDC',
    tokens: ['WETH', 'AERO'], // 2 non-anchor → 2 directed triangles
    amountInDecimal: '100',
    feeTier: 3000,
    gasOracle: fixedGasOracle(),
    nativeUsd: () => 2500,
    channel,
    intervalMs: 1_000_000, // never auto-tick in tests
    log: () => { /* silence */ },
  };
}

describe('TriangularEngine', () => {
  it('enumerates N*(N-1) triangles for N non-anchor tokens', () => {
    const channel = new FakeChannel();
    const engine = new TriangularEngine(baseConfig(profitableClient(), channel));
    // 2 non-anchor → 2 * 1 = 2
    expect(engine.triangleCount()).toBe(2);
  });

  it('publishes every priced triangle when net clears minNetUsd', async () => {
    const channel = new FakeChannel();
    const engine = new TriangularEngine({
      ...baseConfig(profitableClient(), channel),
      minNetUsd: 0.01,
    });
    const result = await engine.tick();
    expect(result.triangles).toBe(2);
    expect(result.priced).toBe(2);
    expect(result.published).toBe(2);
    expect(result.topNetUsd).toBeGreaterThan(0);
    expect(channel.published).toHaveLength(2);
    for (const opp of channel.published) {
      expect(opp.category).toBe('dex_triangular');
      expect(opp.route?.chain).toBe('base');
      expect(opp.route?.hops).toHaveLength(3);
    }
  });

  it('filters out triangles that do not meet minNetUsd', async () => {
    const channel = new FakeChannel();
    const engine = new TriangularEngine({
      ...baseConfig(profitableClient(), channel),
      minNetUsd: 100, // unreachable
    });
    const result = await engine.tick();
    expect(result.priced).toBe(2);
    expect(result.published).toBe(0);
    expect(channel.published).toHaveLength(0);
  });

  it('prices losing routes but does not publish them', async () => {
    const channel = new FakeChannel();
    const engine = new TriangularEngine({
      ...baseConfig(losingClient(), channel),
      minNetUsd: 0.01,
    });
    const result = await engine.tick();
    expect(result.priced).toBe(2);
    expect(result.published).toBe(0);
    expect(result.topNetUsd).toBe(0); // negative nets don't bump topNetUsd above initial 0
  });

  it('advances the cursor so successive ticks scan different slices when maxPerTick < total', async () => {
    const channel = new FakeChannel();
    const engine = new TriangularEngine({
      ...baseConfig(profitableClient(), channel),
      maxPerTick: 1,
      minNetUsd: 0.01,
    });
    const t1 = await engine.tick();
    const t2 = await engine.tick();
    expect(t1.triangles).toBe(1);
    expect(t2.triangles).toBe(1);
    // Two different triangles over the two ticks — asserted via 2 publishes total.
    expect(channel.published).toHaveLength(2);
  });
});
