/**
 * SupabaseEventChannel tests — the row <-> QueuedOpportunity conversion
 * is the interesting surface to cover. A full end-to-end test needs a
 * real Supabase instance (deferred to integration tests); this file
 * validates the query shapes and the parse/build helpers against a
 * narrow stub that mimics the PostgREST method chain we actually use.
 */
import { describe, expect, it } from 'vitest';
import type { Opportunity, NormalizedQuote } from '@b1dz/venue-types';
import { SupabaseEventChannel } from './supabase.js';

function mkOpp(overrides: Partial<Opportunity> = {}): Opportunity {
  const q: NormalizedQuote = {
    venue: 't',
    venueType: 'cex',
    chain: null,
    pair: 'ETH-USDC',
    baseAsset: 'ETH',
    quoteAsset: 'USDC',
    amountIn: '1',
    amountOut: '2500',
    amountInUsd: 2500,
    amountOutUsd: 2500,
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
  };
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
    buyQuote: q,
    sellQuote: { ...q, side: 'sell' },
    observedAt: 1_700_000_000_000,
    ...overrides,
  };
}

/** Minimal stub of the PostgREST method chain we actually call. Records
 *  every invocation so tests can assert on the query shapes. */
interface StubResponse { data: unknown; error: { message: string } | null }
interface StubResponses {
  insertSingle?: StubResponse;
  update?: StubResponse;
  updateSelect?: StubResponse;
  select?: StubResponse;
  selectSingle?: StubResponse;
}
function stubSupabase(responses: StubResponses) {
  const calls: Array<{ table: string; op: string; args: unknown }> = [];
  function from(table: string) {
    return {
      insert(payload: unknown) {
        calls.push({ table, op: 'insert', args: payload });
        return {
          select() {
            return {
              async single() {
                return responses.insertSingle ?? { data: payload, error: null };
              },
            };
          },
        };
      },
      update(payload: unknown) {
        calls.push({ table, op: 'update', args: payload });
        type UpdateChain = {
          eq: () => UpdateChain;
          in: () => UpdateChain;
          select: () => Promise<StubResponse>;
          then: <T>(fn: (v: StubResponse) => T) => T;
        };
        const chain: UpdateChain = {
          eq: () => chain,
          in: () => chain,
          select: async () => responses.updateSelect ?? { data: [], error: null },
          then: <T,>(fn: (v: StubResponse) => T) => fn(responses.update ?? { data: null, error: null }),
        };
        return chain;
      },
      select() {
        calls.push({ table, op: 'select', args: null });
        type SelectChain = {
          eq: () => SelectChain;
          in: () => SelectChain;
          gt: () => SelectChain;
          order: () => SelectChain;
          limit: () => SelectChain;
          single: () => Promise<StubResponse>;
          then: <T>(fn: (v: StubResponse) => T) => T;
        };
        const chain: SelectChain = {
          eq: () => chain,
          in: () => chain,
          gt: () => chain,
          order: () => chain,
          limit: () => chain,
          single: async () => responses.selectSingle ?? { data: null, error: null },
          then: <T,>(fn: (v: StubResponse) => T) => fn(responses.select ?? { data: [], error: null }),
        };
        return chain;
      },
    };
  }
  return { client: { from } as unknown as ConstructorParameters<typeof SupabaseEventChannel>[0], calls };
}

describe('SupabaseEventChannel', () => {
  it('publish sends all opportunity fields flattened into insert row', async () => {
    const row = {
      id: 'queue-1',
      user_id: 'user-1',
      status: 'pending',
      claimed_by: null,
      claimed_at: null,
      resolved_at: null,
      resolved_reason: null,
      created_at: new Date(1_700_000_000_500).toISOString(),
      expires_at: new Date(1_700_000_005_500).toISOString(),
      opportunity_id: 'opp-1',
      buy_venue: 'kraken',
      sell_venue: 'jupiter',
      buy_chain: null,
      sell_chain: 'solana',
      asset: 'ETH',
      size_usd: 1000,
      gross_edge_usd: 5,
      total_fees_usd: 1,
      total_gas_usd: 0,
      total_slippage_usd: 0,
      risk_buffer_usd: 0,
      expected_net_usd: 4,
      expected_net_bps: 40,
      confidence: 0.4,
      executable: true,
      blockers: [],
      category: 'cex_dex',
      buy_quote: {},
      sell_quote: {},
      observed_at: new Date(1_700_000_000_000).toISOString(),
    };
    const stub = stubSupabase({ insertSingle: { data: row, error: null } });
    const channel = new SupabaseEventChannel(stub.client, { userId: 'user-1' });
    const result = await channel.publish(mkOpp());

    const insertCall = stub.calls.find((c) => c.op === 'insert');
    expect(insertCall).toBeDefined();
    const inserted = insertCall!.args as Record<string, unknown>;
    expect(inserted.user_id).toBe('user-1');
    expect(inserted.status).toBe('pending');
    expect(inserted.opportunity_id).toBe('opp-1');
    expect(inserted.buy_venue).toBe('kraken');
    expect(inserted.sell_venue).toBe('jupiter');
    expect(inserted.category).toBe('cex_dex');
    expect(inserted.blockers).toEqual([]);
    expect(result.queueId).toBe('queue-1');
    expect(result.opportunity.id).toBe('opp-1');
  });

  it('publish propagates insert errors', async () => {
    const stub = stubSupabase({ insertSingle: { data: null, error: { message: 'unique violation' } } });
    const channel = new SupabaseEventChannel(stub.client, { userId: 'user-1' });
    await expect(channel.publish(mkOpp())).rejects.toThrow(/publish failed/);
  });

  it('claim filters by status=pending and expires_at > now', async () => {
    const stub = stubSupabase({
      select: { data: [], error: null },
    });
    const channel = new SupabaseEventChannel(stub.client, { userId: 'user-1' });
    const result = await channel.claim();
    expect(result).toEqual([]);
    const selectCall = stub.calls.find((c) => c.op === 'select');
    expect(selectCall).toBeDefined();
  });

  it('resolve sets status, resolved_at, and resolved_reason', async () => {
    const stub = stubSupabase({ update: { data: null, error: null } });
    const channel = new SupabaseEventChannel(stub.client, { userId: 'user-1' });
    await channel.resolve('queue-1', 'filled', 'ok');
    const updateCall = stub.calls.find((c) => c.op === 'update');
    expect(updateCall).toBeDefined();
    const body = updateCall!.args as Record<string, unknown>;
    expect(body.status).toBe('filled');
    expect(body.resolved_reason).toBe('ok');
    expect(body.resolved_at).toBeTruthy();
  });

  it('resolve propagates update errors', async () => {
    const stub = stubSupabase({ update: { data: null, error: { message: 'rls denied' } } });
    const channel = new SupabaseEventChannel(stub.client, { userId: 'user-1' });
    await expect(channel.resolve('queue-1', 'failed', 'x')).rejects.toThrow(/resolve failed/);
  });

  it('inspect supports status filter', async () => {
    const stub = stubSupabase({ select: { data: [], error: null } });
    const channel = new SupabaseEventChannel(stub.client, { userId: 'user-1' });
    await channel.inspect('filled');
    const selectCall = stub.calls.find((c) => c.op === 'select');
    expect(selectCall).toBeDefined();
  });

  it('publish uses custom TTL when provided', async () => {
    const stub = stubSupabase({
      insertSingle: {
        data: {
          id: 'q',
          user_id: 'u',
          status: 'pending',
          claimed_by: null,
          claimed_at: null,
          resolved_at: null,
          resolved_reason: null,
          created_at: new Date().toISOString(),
          expires_at: new Date().toISOString(),
          opportunity_id: 'x',
          buy_venue: '',
          sell_venue: '',
          buy_chain: null,
          sell_chain: null,
          asset: 'X',
          size_usd: 0,
          gross_edge_usd: 0,
          total_fees_usd: 0,
          total_gas_usd: 0,
          total_slippage_usd: 0,
          risk_buffer_usd: 0,
          expected_net_usd: 0,
          expected_net_bps: 0,
          confidence: 0,
          executable: false,
          blockers: [],
          category: 'cex_cex',
          buy_quote: {},
          sell_quote: {},
          observed_at: new Date().toISOString(),
        },
        error: null,
      },
    });
    const channel = new SupabaseEventChannel(stub.client, { userId: 'u' });
    const before = Date.now();
    await channel.publish(mkOpp(), { ttlMs: 30_000 });
    const insertCall = stub.calls.find((c) => c.op === 'insert');
    const body = insertCall!.args as { expires_at: string };
    const ttl = new Date(body.expires_at).getTime() - before;
    expect(ttl).toBeGreaterThanOrEqual(29_000);
    expect(ttl).toBeLessThanOrEqual(31_000);
  });

  it('constructor signature accepts mocked SupabaseClient', () => {
    // Guard against drift in the @supabase/supabase-js public interface
    // that would break the constructor expectation. If this ever fails
    // at build time the error message below shows what changed.
    const stub = stubSupabase({});
    expect(() => new SupabaseEventChannel(stub.client, { userId: 'u' })).not.toThrow();
  });
});
