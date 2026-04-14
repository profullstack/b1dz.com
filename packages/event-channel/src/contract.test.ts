/**
 * Channel contract tests — same behavior expected from every EventChannel
 * implementation. The in-memory impl is run directly here; the Supabase
 * impl gets the same tests via the harness below against a mocked
 * Supabase client, guaranteeing the two stay in step.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import type { Opportunity, NormalizedQuote } from '@b1dz/venue-types';
import type { EventChannel, QueuedOpportunity } from './types.js';
import { InMemoryEventChannel } from './in-memory.js';

function mkQuote(overrides: Partial<NormalizedQuote> = {}): NormalizedQuote {
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
    quoteTimestamp: 0,
    raw: null,
    ...overrides,
  };
}

function mkOpp(overrides: Partial<Opportunity> = {}): Opportunity {
  return {
    id: 'opp-1',
    buyVenue: 'kraken',
    sellVenue: 'jupiter',
    buyChain: null,
    sellChain: 'solana',
    asset: 'ETH',
    size: '1000',
    grossEdgeUsd: 5,
    totalFeesUsd: 1,
    totalGasUsd: 0,
    totalSlippageUsd: 0,
    riskBufferUsd: 0,
    expectedNetUsd: 4,
    expectedNetBps: 40,
    confidence: 0.4,
    blockers: [],
    executable: true,
    category: 'cex_dex',
    buyQuote: mkQuote({ venue: 'kraken' }),
    sellQuote: mkQuote({ venue: 'jupiter', side: 'sell' }),
    observedAt: 1_700_000_000_000,
    ...overrides,
  };
}

export function runEventChannelContract(label: string, make: () => EventChannel): void {
  describe(`${label} — event channel contract`, () => {
    let channel: EventChannel;

    beforeEach(() => {
      channel = make();
    });

    it('publish stores opportunity in pending state', async () => {
      const q = await channel.publish(mkOpp());
      expect(q.status).toBe('pending');
      expect(q.queueId).toBeTruthy();
      expect(q.opportunity.id).toBe('opp-1');
      const pending = await channel.inspect('pending');
      expect(pending).toHaveLength(1);
    });

    it('claim atomically transitions pending -> claimed', async () => {
      await channel.publish(mkOpp());
      const claimed = await channel.claim({ claimer: 'daemon-1' });
      expect(claimed).toHaveLength(1);
      expect(claimed[0]!.status).toBe('claimed');
      expect(claimed[0]!.claimedBy).toBe('daemon-1');

      // A second claim should see no pending rows.
      const again = await channel.claim();
      expect(again).toHaveLength(0);
    });

    it('claim respects limit', async () => {
      await channel.publish(mkOpp({ id: 'a' }));
      await channel.publish(mkOpp({ id: 'b' }));
      await channel.publish(mkOpp({ id: 'c' }));
      const claimed = await channel.claim({ limit: 2 });
      expect(claimed).toHaveLength(2);
    });

    it('claim returns opportunities oldest-first', async () => {
      await channel.publish(mkOpp({ id: 'first' }));
      await new Promise((r) => setTimeout(r, 2));
      await channel.publish(mkOpp({ id: 'second' }));
      const claimed = await channel.claim({ limit: 2 });
      expect(claimed.map((c) => c.opportunity.id)).toEqual(['first', 'second']);
    });

    it('resolve transitions claimed -> filled/rejected/failed', async () => {
      const pub = await channel.publish(mkOpp());
      await channel.claim();
      await channel.resolve(pub.queueId, 'filled', 'tx confirmed 0xabc');
      const inspected = await channel.inspect();
      const row = inspected.find((r) => r.queueId === pub.queueId);
      expect(row?.status).toBe('filled');
      expect(row?.resolvedReason).toBe('tx confirmed 0xabc');
    });

    it('expired opportunities are not claimed and flip to expired status', async () => {
      // publish with a 0ms TTL so it's immediately expired.
      await channel.publish(mkOpp({ id: 'too-late' }), { ttlMs: 0 });
      const claimed = await channel.claim();
      expect(claimed).toHaveLength(0);
      const expired = await channel.inspect('expired');
      expect(expired.map((e) => e.opportunity.id)).toContain('too-late');
    });

    it('publish preserves opportunity fields end-to-end', async () => {
      const opp = mkOpp({
        id: 'round-trip',
        grossEdgeUsd: 3.14,
        blockers: ['stale quote 2s', 'risk cap'],
        executable: false,
      });
      const pub = await channel.publish(opp);
      const inspected = await channel.inspect();
      const match = inspected.find((r) => r.queueId === pub.queueId);
      expect(match?.opportunity.grossEdgeUsd).toBeCloseTo(3.14, 5);
      expect(match?.opportunity.blockers).toEqual(['stale quote 2s', 'risk cap']);
      expect(match?.opportunity.executable).toBe(false);
    });

    it('resolve throws on unknown queueId', async () => {
      await expect(channel.resolve('does-not-exist', 'failed', 'test')).rejects.toThrow();
    });

    it('inspect supports status filter', async () => {
      await channel.publish(mkOpp({ id: 'a' }));
      const b = await channel.publish(mkOpp({ id: 'b' }));
      await channel.claim({ limit: 1 }); // claim oldest = 'a'
      await channel.resolve(b.queueId, 'rejected', 'manual');
      const pending = await channel.inspect('pending');
      expect(pending).toHaveLength(0);
      const claimed = await channel.inspect('claimed');
      expect(claimed.map((r) => r.opportunity.id)).toEqual(['a']);
      const rejected = await channel.inspect('rejected');
      expect(rejected.map((r) => r.opportunity.id)).toEqual(['b']);
    });
  });
}

// In-memory impl runs the whole contract directly.
let counter = 0;
runEventChannelContract('InMemoryEventChannel', () => new InMemoryEventChannel({
  uuid: () => `mem-${++counter}`,
}));
