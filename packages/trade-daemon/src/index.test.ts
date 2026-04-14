import { describe, expect, it, beforeEach } from 'vitest';
import { InMemoryEventChannel, type QueuedOpportunity } from '@b1dz/event-channel';
import type { Opportunity, NormalizedQuote } from '@b1dz/venue-types';
import {
  CircuitBreaker,
  TradeDaemon,
  decideOpportunity,
  DEFAULT_RISK_LIMITS,
  type Executor,
  type ExecutorOutcome,
  type InventoryCheck,
} from './index.js';

function mkQuote(o: Partial<NormalizedQuote> = {}): NormalizedQuote {
  return {
    venue: 'v',
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
    slippageBps: 10,
    priceImpactBps: null,
    routeHops: 1,
    routeSummary: [],
    quoteTimestamp: Date.now(),
    raw: null,
    ...o,
  };
}

function mkOpp(o: Partial<Opportunity> = {}): Opportunity {
  return {
    id: 'opp-1',
    buyVenue: 'kraken',
    sellVenue: 'jupiter',
    buyChain: null,
    sellChain: 'solana',
    asset: 'ETH',
    size: '50',
    grossEdgeUsd: 5,
    totalFeesUsd: 1,
    totalGasUsd: 0.5,
    totalSlippageUsd: 0.1,
    riskBufferUsd: 0,
    expectedNetUsd: 3.4,
    expectedNetBps: 680,
    confidence: 0.8,
    blockers: [],
    executable: true,
    category: 'cex_dex',
    buyQuote: mkQuote(),
    sellQuote: mkQuote({ side: 'sell' }),
    observedAt: Date.now(),
    ...o,
  };
}

function mkQueued(o: Partial<QueuedOpportunity> = {}): QueuedOpportunity {
  return {
    queueId: 'q-1',
    status: 'claimed',
    claimedBy: 'test',
    claimedAt: Date.now(),
    resolvedAt: null,
    resolvedReason: null,
    createdAt: Date.now(),
    expiresAt: Date.now() + 5000,
    opportunity: mkOpp(),
    ...o,
  };
}

describe('decideOpportunity', () => {
  const now = 1_700_000_000_000;

  it('rejects when observer flagged non-executable', () => {
    const d = decideOpportunity(mkQueued({ opportunity: mkOpp({ executable: false }) }), 'paper', DEFAULT_RISK_LIMITS, now);
    expect(d.decision).toBe('reject');
    expect(d.reasons.join('')).toMatch(/non-executable/);
  });

  it('rejects when net USD is below min', () => {
    const d = decideOpportunity(mkQueued({ opportunity: mkOpp({ expectedNetUsd: 1 }) }), 'paper', DEFAULT_RISK_LIMITS, now);
    expect(d.decision).toBe('reject');
    expect(d.reasons.some((r) => r.includes('net '))).toBe(true);
  });

  it('rejects when net BPS is below min', () => {
    const d = decideOpportunity(mkQueued({ opportunity: mkOpp({ expectedNetBps: 5 }) }), 'paper', DEFAULT_RISK_LIMITS, now);
    expect(d.decision).toBe('reject');
    expect(d.reasons.some((r) => r.includes('bps'))).toBe(true);
  });

  it('rejects when size exceeds maxTradeUsd', () => {
    const d = decideOpportunity(mkQueued({ opportunity: mkOpp({ size: '500' }) }), 'paper', DEFAULT_RISK_LIMITS, now);
    expect(d.decision).toBe('reject');
    expect(d.reasons.some((r) => r.includes('size'))).toBe(true);
  });

  it('rejects when gas exceeds maxGasUsd', () => {
    const d = decideOpportunity(mkQueued({ opportunity: mkOpp({ totalGasUsd: 10 }) }), 'paper', DEFAULT_RISK_LIMITS, now);
    expect(d.decision).toBe('reject');
    expect(d.reasons.some((r) => r.includes('gas'))).toBe(true);
  });

  it('rejects when combined slippage exceeds maxSlippageBps', () => {
    const d = decideOpportunity(
      mkQueued({ opportunity: mkOpp({ buyQuote: mkQuote({ slippageBps: 40 }), sellQuote: mkQuote({ slippageBps: 40 }) }) }),
      'paper',
      DEFAULT_RISK_LIMITS,
      now,
    );
    expect(d.decision).toBe('reject');
    expect(d.reasons.some((r) => r.includes('slip'))).toBe(true);
  });

  it('rejects when hops exceed maxRouteHops', () => {
    const d = decideOpportunity(
      mkQueued({ opportunity: mkOpp({ buyQuote: mkQuote({ routeHops: 5 }) }) }),
      'paper',
      DEFAULT_RISK_LIMITS,
      now,
    );
    expect(d.decision).toBe('reject');
    expect(d.reasons.some((r) => r.includes('hops'))).toBe(true);
  });

  it('rejects when the opp expired before claim', () => {
    const d = decideOpportunity(mkQueued({ expiresAt: now - 1 }), 'paper', DEFAULT_RISK_LIMITS, now);
    expect(d.decision).toBe('reject');
    expect(d.reasons.some((r) => r.includes('expired'))).toBe(true);
  });

  it('observe mode always marks opportunity as reject with "observe mode" reason', () => {
    const d = decideOpportunity(mkQueued(), 'observe', DEFAULT_RISK_LIMITS, now);
    expect(d.decision).toBe('reject');
    expect(d.reasons).toEqual(['observe mode']);
  });

  it('paper mode executes when all gates pass', () => {
    const d = decideOpportunity(mkQueued(), 'paper', DEFAULT_RISK_LIMITS, now);
    expect(d.decision).toBe('paper');
    expect(d.terminalStatus).toBe('filled');
    expect(d.resolvedReason).toMatch(/paper fill/);
  });

  it('live mode returns execute decision (path stubbed until wallet-provider lands)', () => {
    const d = decideOpportunity(mkQueued(), 'live', DEFAULT_RISK_LIMITS, now);
    expect(d.decision).toBe('execute');
    expect(d.terminalStatus).toBe('filled');
  });

  it('accumulates all failed reasons, not just the first', () => {
    const d = decideOpportunity(
      mkQueued({ opportunity: mkOpp({ expectedNetUsd: 0.5, totalGasUsd: 20 }) }),
      'paper',
      DEFAULT_RISK_LIMITS,
      now,
    );
    expect(d.reasons.length).toBeGreaterThanOrEqual(2);
  });

  it('rejects when opportunity requires higher execution mode than daemon supports', () => {
    const opp = mkOpp({
      execution: {
        realizabilityScore: 0.9,
        mevRiskScore: 0.2,
        latencyRiskScore: 0.1,
        requiresPrivateFlow: true,
        recommendedExecutionMode: 'private',
        simulationNotes: [],
      },
    });
    const d = decideOpportunity(mkQueued({ opportunity: opp }), 'paper', DEFAULT_RISK_LIMITS, now);
    expect(d.decision).toBe('reject');
    expect(d.reasons.some((r) => r.includes('requires private'))).toBe(true);
  });

  it('accepts a private-mode opportunity when daemon is configured for bundle execution', () => {
    const opp = mkOpp({
      execution: {
        realizabilityScore: 0.9,
        mevRiskScore: 0.2,
        latencyRiskScore: 0.1,
        requiresPrivateFlow: true,
        recommendedExecutionMode: 'private',
        simulationNotes: [],
      },
    });
    const d = decideOpportunity(
      mkQueued({ opportunity: opp }),
      'paper',
      { ...DEFAULT_RISK_LIMITS, executionMode: 'bundle' },
      now,
    );
    expect(d.decision).toBe('paper');
  });

  it('rejects when realizability score is below the daemon threshold', () => {
    const opp = mkOpp({
      execution: {
        realizabilityScore: 0.2,
        mevRiskScore: 0.2,
        latencyRiskScore: 0.1,
        requiresPrivateFlow: false,
        recommendedExecutionMode: 'public',
        simulationNotes: [],
      },
    });
    const d = decideOpportunity(mkQueued({ opportunity: opp }), 'paper', DEFAULT_RISK_LIMITS, now);
    expect(d.decision).toBe('reject');
    expect(d.reasons.some((r) => r.includes('realizability'))).toBe(true);
  });

  it('rejects a public-mode route whose MEV risk is too high', () => {
    const opp = mkOpp({
      execution: {
        realizabilityScore: 0.8,
        mevRiskScore: 0.9,
        latencyRiskScore: 0.1,
        requiresPrivateFlow: false,
        recommendedExecutionMode: 'public',
        simulationNotes: [],
      },
    });
    const d = decideOpportunity(mkQueued({ opportunity: opp }), 'paper', DEFAULT_RISK_LIMITS, now);
    expect(d.decision).toBe('reject');
    expect(d.reasons.some((r) => r.includes('MEV'))).toBe(true);
  });

  it('rejects any opportunity recommended as paper_only when daemon runs live', () => {
    const opp = mkOpp({
      execution: {
        realizabilityScore: 0.9,
        mevRiskScore: 0.1,
        latencyRiskScore: 0.1,
        requiresPrivateFlow: false,
        recommendedExecutionMode: 'paper_only',
        simulationNotes: [],
      },
    });
    const d = decideOpportunity(mkQueued({ opportunity: opp }), 'live', DEFAULT_RISK_LIMITS, now);
    expect(d.decision).toBe('reject');
    expect(d.reasons.some((r) => r.includes('paper_only'))).toBe(true);
  });
});

describe('TradeDaemon.tick', () => {
  let channel: InMemoryEventChannel;
  beforeEach(() => {
    channel = new InMemoryEventChannel({ uuid: () => `q-${Math.random().toString(36).slice(2, 8)}` });
  });

  async function seed(opp: Opportunity): Promise<string> {
    const q = await channel.publish(opp, { ttlMs: 60_000 });
    return q.queueId;
  }

  it('claims pending opportunities and resolves each', async () => {
    const id = await seed(mkOpp());
    const daemon = new TradeDaemon({ channel, mode: 'paper', log: () => {} });
    const decisions = await daemon.tick();
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.queueId).toBe(id);
    expect(decisions[0]!.decision).toBe('paper');
    const filled = await channel.inspect('filled');
    expect(filled).toHaveLength(1);
  });

  it('rejects opportunities that fail risk gates and records them', async () => {
    await seed(mkOpp({ expectedNetUsd: 0.1 }));
    const daemon = new TradeDaemon({ channel, mode: 'paper', log: () => {} });
    await daemon.tick();
    const rejected = await channel.inspect('rejected');
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.resolvedReason).toMatch(/net/);
  });

  it('rejects all opportunities in observe mode', async () => {
    await seed(mkOpp());
    await seed(mkOpp({ id: 'opp-2' }));
    const daemon = new TradeDaemon({ channel, mode: 'observe', log: () => {} });
    await daemon.tick();
    const rejected = await channel.inspect('rejected');
    expect(rejected).toHaveLength(2);
    expect(rejected.every((r) => r.resolvedReason === 'observe mode — no execution')).toBe(true);
  });

  it('batch size limits how many get claimed per tick', async () => {
    for (let i = 0; i < 5; i++) await seed(mkOpp({ id: `opp-${i}` }));
    const daemon = new TradeDaemon({ channel, mode: 'paper', batchSize: 2, log: () => {} });
    const first = await daemon.tick();
    expect(first).toHaveLength(2);
    const second = await daemon.tick();
    expect(second).toHaveLength(2);
    const third = await daemon.tick();
    expect(third).toHaveLength(1);
    const empty = await daemon.tick();
    expect(empty).toHaveLength(0);
  });

  it('resolves each opportunity to its own terminal status (mixed pass/fail)', async () => {
    await seed(mkOpp({ id: 'good' }));
    await seed(mkOpp({ id: 'bad', expectedNetUsd: 0 }));
    const daemon = new TradeDaemon({ channel, mode: 'paper', log: () => {} });
    await daemon.tick();
    const filled = (await channel.inspect('filled')).map((r) => r.opportunity.id);
    const rejected = (await channel.inspect('rejected')).map((r) => r.opportunity.id);
    expect(filled).toContain('good');
    expect(rejected).toContain('bad');
  });

  it('returns empty when the queue is empty', async () => {
    const daemon = new TradeDaemon({ channel, mode: 'paper', log: () => {} });
    expect(await daemon.tick()).toHaveLength(0);
  });

  it('uses custom risk overrides', async () => {
    await seed(mkOpp({ expectedNetUsd: 1 }));
    // Default minNetUsd=2 would reject this. Override to 0.5 lets it through.
    const daemon = new TradeDaemon({ channel, mode: 'paper', risk: { minNetUsd: 0.5, minNetBps: 0 }, log: () => {} });
    const decisions = await daemon.tick();
    expect(decisions[0]!.decision).toBe('paper');
  });

  it('never executes in observe mode even with permissive risk', async () => {
    await seed(mkOpp());
    const daemon = new TradeDaemon({ channel, mode: 'observe', risk: { minNetUsd: 0, minNetBps: 0 }, log: () => {} });
    const decisions = await daemon.tick();
    expect(decisions[0]!.decision).toBe('reject');
  });
});

describe('TradeDaemon live mode (executors + inventory)', () => {
  let channel: InMemoryEventChannel;
  beforeEach(() => {
    channel = new InMemoryEventChannel({ uuid: () => `q-${Math.random().toString(36).slice(2, 8)}` });
  });

  function mkExecutor(outcome: ExecutorOutcome, matcher: (o: Opportunity) => boolean = () => true): Executor {
    return {
      canExecute: matcher,
      execute: async () => outcome,
    };
  }

  it('aborts in live mode when no executor is wired', async () => {
    await channel.publish(mkOpp(), { ttlMs: 60_000 });
    const daemon = new TradeDaemon({ channel, mode: 'live', log: () => {} });
    await daemon.tick();
    const rejected = await channel.inspect('rejected');
    expect(rejected[0]!.resolvedReason).toMatch(/no Executor wired/);
  });

  it('aborts when no executor matches the opportunity', async () => {
    await channel.publish(mkOpp({ buyVenue: 'xyz' }), { ttlMs: 60_000 });
    const daemon = new TradeDaemon({
      channel, mode: 'live', log: () => {},
      executors: [mkExecutor({ status: 'filled', resolvedReason: 'ok' }, () => false)],
    });
    await daemon.tick();
    const rejected = await channel.inspect('rejected');
    expect(rejected[0]!.resolvedReason).toMatch(/no executor can handle/);
  });

  it('dispatches to the first matching executor and records filled', async () => {
    await channel.publish(mkOpp(), { ttlMs: 60_000 });
    let executed = 0;
    const daemon = new TradeDaemon({
      channel, mode: 'live', log: () => {},
      executors: [{
        canExecute: () => true,
        execute: async () => {
          executed++;
          return { status: 'filled', resolvedReason: 'swapped', externalId: '0xhash' };
        },
      }],
    });
    const decisions = await daemon.tick();
    expect(executed).toBe(1);
    expect(decisions[0]!.terminalStatus).toBe('filled');
    expect(decisions[0]!.resolvedReason).toMatch(/ref=0xhash/);
    const filled = await channel.inspect('filled');
    expect(filled).toHaveLength(1);
  });

  it('records a reverted executor outcome as status=failed', async () => {
    await channel.publish(mkOpp(), { ttlMs: 60_000 });
    const daemon = new TradeDaemon({
      channel, mode: 'live', log: () => {},
      executors: [mkExecutor({ status: 'reverted', resolvedReason: 'swap reverted: slippage' })],
    });
    await daemon.tick();
    const failed = await channel.inspect('failed');
    expect(failed[0]!.resolvedReason).toMatch(/reverted/);
  });

  it('records a stuck executor outcome as status=failed', async () => {
    await channel.publish(mkOpp(), { ttlMs: 60_000 });
    const daemon = new TradeDaemon({
      channel, mode: 'live', log: () => {},
      executors: [mkExecutor({ status: 'stuck', resolvedReason: 'tx still pending after timeout' })],
    });
    await daemon.tick();
    const failed = await channel.inspect('failed');
    expect(failed[0]!.resolvedReason).toMatch(/stuck|pending/);
  });

  it('inventory.canAfford blocks the executor from running', async () => {
    await channel.publish(mkOpp(), { ttlMs: 60_000 });
    let executed = 0;
    const inv: InventoryCheck = { canAfford: async () => 'insufficient USDC' };
    const daemon = new TradeDaemon({
      channel, mode: 'live', log: () => {},
      inventory: inv,
      executors: [{
        canExecute: () => true,
        execute: async () => { executed++; return { status: 'filled', resolvedReason: 'shouldnt happen' }; },
      }],
    });
    await daemon.tick();
    expect(executed).toBe(0);
    const rejected = await channel.inspect('rejected');
    expect(rejected[0]!.resolvedReason).toMatch(/insufficient USDC/);
  });

  it('inventory check returning null allows the executor to run', async () => {
    await channel.publish(mkOpp(), { ttlMs: 60_000 });
    const inv: InventoryCheck = { canAfford: () => null };
    const daemon = new TradeDaemon({
      channel, mode: 'live', log: () => {},
      inventory: inv,
      executors: [mkExecutor({ status: 'filled', resolvedReason: 'ok' })],
    });
    await daemon.tick();
    const filled = await channel.inspect('filled');
    expect(filled).toHaveLength(1);
  });

  it('catches executor exceptions and records status=rejected', async () => {
    await channel.publish(mkOpp(), { ttlMs: 60_000 });
    const daemon = new TradeDaemon({
      channel, mode: 'live', log: () => {},
      executors: [{
        canExecute: () => true,
        execute: async () => { throw new Error('RPC exploded'); },
      }],
    });
    await daemon.tick();
    const rejected = await channel.inspect('rejected');
    expect(rejected[0]!.resolvedReason).toMatch(/executor threw: RPC exploded/);
  });

  it('catches inventory-check exceptions and records status=rejected', async () => {
    await channel.publish(mkOpp(), { ttlMs: 60_000 });
    const inv: InventoryCheck = { canAfford: async () => { throw new Error('db down'); } };
    const daemon = new TradeDaemon({
      channel, mode: 'live', log: () => {},
      inventory: inv,
      executors: [mkExecutor({ status: 'filled', resolvedReason: 'ok' })],
    });
    await daemon.tick();
    const rejected = await channel.inspect('rejected');
    expect(rejected[0]!.resolvedReason).toMatch(/inventory check failed/);
  });

  it('picks the first executor whose canExecute returns true', async () => {
    await channel.publish(mkOpp(), { ttlMs: 60_000 });
    const calls: string[] = [];
    const daemon = new TradeDaemon({
      channel, mode: 'live', log: () => {},
      executors: [
        {
          canExecute: () => false,
          execute: async () => { calls.push('a'); return { status: 'filled', resolvedReason: 'a' }; },
        },
        {
          canExecute: () => true,
          execute: async () => { calls.push('b'); return { status: 'filled', resolvedReason: 'b' }; },
        },
        {
          canExecute: () => true,
          execute: async () => { calls.push('c'); return { status: 'filled', resolvedReason: 'c' }; },
        },
      ],
    });
    await daemon.tick();
    expect(calls).toEqual(['b']);
  });

  it('refuses execution once the circuit is tripped externally', async () => {
    await channel.publish(mkOpp(), { ttlMs: 60_000 });
    await channel.publish(mkOpp({ id: 'opp-2' }), { ttlMs: 60_000 });
    const circuit = new CircuitBreaker();
    circuit.trip('gas spike 5x baseline');
    let executed = 0;
    const daemon = new TradeDaemon({
      channel, mode: 'live', log: () => {}, circuit,
      executors: [{
        canExecute: () => true,
        execute: async () => { executed++; return { status: 'filled', resolvedReason: 'ok' }; },
      }],
    });
    await daemon.tick();
    expect(executed).toBe(0);
    const rejected = await channel.inspect('rejected');
    expect(rejected.length).toBeGreaterThanOrEqual(1);
    expect(rejected[0]!.resolvedReason).toMatch(/circuit open/);
  });

  it('trips the circuit after repeated executor failures and stops processing', async () => {
    for (let i = 0; i < 5; i++) await channel.publish(mkOpp({ id: `opp-${i}` }), { ttlMs: 60_000 });
    let attempts = 0;
    const circuit = new CircuitBreaker({ config: { maxConsecutiveFailures: 2, maxDailyLossUsd: 1_000_000, dailyResetHourUtc: 0 } });
    const daemon = new TradeDaemon({
      channel, mode: 'live', log: () => {}, circuit,
      executors: [{
        canExecute: () => true,
        execute: async () => { attempts++; return { status: 'reverted', resolvedReason: 'test revert' }; },
      }],
    });
    await daemon.tick();
    // After 2 reverts the circuit trips; remaining 3 opps in the tick
    // should all be blocked by the open circuit.
    expect(attempts).toBe(2);
    expect(circuit.status().state).toBe('open');
  });

  it('getCircuit exposes the breaker for dashboards + external trips', () => {
    const daemon = new TradeDaemon({ channel, mode: 'live', log: () => {} });
    const cb = daemon.getCircuit();
    expect(cb.status().state).toBe('closed');
    cb.trip('manual');
    expect(cb.canExecute()).toMatch(/manual/);
  });

  it('daily loss from pnlFromOutcome trips the circuit', async () => {
    for (let i = 0; i < 3; i++) await channel.publish(mkOpp({ id: `opp-${i}` }), { ttlMs: 60_000 });
    const circuit = new CircuitBreaker({ config: { maxConsecutiveFailures: 999, maxDailyLossUsd: 10, dailyResetHourUtc: 0 } });
    const daemon = new TradeDaemon({
      channel, mode: 'live', log: () => {}, circuit,
      pnlFromOutcome: () => -5,
      executors: [{
        canExecute: () => true,
        execute: async () => ({ status: 'filled', resolvedReason: 'ok' }),
      }],
    });
    await daemon.tick();
    expect(circuit.status().state).toBe('open');
    expect(circuit.canExecute()).toMatch(/daily loss/);
  });
});
