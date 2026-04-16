/**
 * Process-wide v2 trading pipeline singleton.
 *
 * Wraps ObserveEngine + InMemoryEventChannel + TradeDaemon at process
 * scope so per-user worker ticks can just snapshot its state into
 * source_state.payload. Init is lazy + idempotent so the daemon boots
 * fast even when no user has the v2 source enabled yet.
 *
 * Mode is driven by env:
 *   V2_MODE=observe|paper|live   (default: observe)
 *   V2_MAX_PAIRS=10              scan cap, prevents N*M*2 quote fan-out
 *   V2_SIZE_USD=100              notional per quote
 *   V2_INTERVAL_MS=5000          observer tick cadence
 *   V2_MIN_NET_USD / V2_MIN_NET_BPS / V2_MAX_TRADE_USD  risk overrides
 *   ZEROX_API_KEY / ONEINCH_API_KEY   enable EVM aggregator adapters
 *
 * Live execution requires an Executor wired in. Until one is registered,
 * live mode aborts every opportunity per TradeDaemon.runLive() contract.
 */

import { defaultCexAdapters } from '@b1dz/adapters-cex';
import { ZeroExAdapter, OneInchAdapter } from '@b1dz/adapters-evm';
import { JupiterAdapter } from '@b1dz/adapters-solana';
import {
  InMemoryEventChannel,
  type OpportunityStatus,
  type PublishOptions,
  type QueuedOpportunity,
} from '@b1dz/event-channel';
import { ObserveEngine, type ObservePair, type AdapterHealthMetric } from '@b1dz/observe-engine';
import {
  TradeDaemon,
  type TradeMode,
  DEFAULT_RISK_LIMITS,
  type Executor,
  type CircuitState,
  type CircuitTrip,
} from '@b1dz/trade-daemon';
import type { VenueAdapter, Opportunity } from '@b1dz/venue-types';
import { getActivePairs } from '@b1dz/source-crypto-arb';

interface DecisionLogEntry {
  queueId: string;
  status: OpportunityStatus;
  reason: string;
  at: number;
}

/**
 * InMemoryEventChannel extension that keeps bounded ring buffers of the
 * latest published opportunities + resolved decisions so worker ticks
 * can cheaply snapshot activity into source_state without walking the
 * full queue on every tick.
 */
class ObservableChannel extends InMemoryEventChannel {
  readonly published: Opportunity[] = [];
  readonly decisions: DecisionLogEntry[] = [];

  override async publish(opp: Opportunity, opts?: PublishOptions): Promise<QueuedOpportunity> {
    const queued = await super.publish(opp, opts);
    this.published.push(opp);
    while (this.published.length > 50) this.published.shift();
    return queued;
  }

  override async resolve(
    queueId: string,
    status: Exclude<OpportunityStatus, 'pending' | 'claimed'>,
    reason: string,
  ): Promise<void> {
    this.decisions.push({ queueId, status, reason, at: Date.now() });
    while (this.decisions.length > 50) this.decisions.shift();
    await super.resolve(queueId, status, reason);
  }
}

export interface V2PipelineSnapshot {
  mode: TradeMode;
  pairs: string[];
  adapters: string[];
  health: AdapterHealthMetric[];
  recentOpportunities: Opportunity[];
  recentDecisions: DecisionLogEntry[];
  circuit: {
    state: CircuitState;
    trip: CircuitTrip | null;
    consecutiveFailures: number;
    dailyLossUsd: number;
  };
  startedAt: number;
  lastRefreshAt: number;
}

interface PipelineState {
  adapters: VenueAdapter[];
  channel: ObservableChannel;
  observer: ObserveEngine;
  daemon: TradeDaemon;
  pairs: string[];
  mode: TradeMode;
  startedAt: number;
  lastRefreshAt: number;
}

let instance: PipelineState | null = null;
let initPromise: Promise<PipelineState> | null = null;
const executors: Executor[] = [];

/** Register an Executor before initV2Pipeline() is called. Once the
 *  pipeline is running, additional executors take no effect because
 *  TradeDaemon captures the list at construction. */
export function registerExecutor(executor: Executor): void {
  if (instance) {
    console.warn('[v2] registerExecutor called after pipeline start — ignored');
    return;
  }
  executors.push(executor);
}

function buildAdapters(): VenueAdapter[] {
  const list: VenueAdapter[] = [...defaultCexAdapters()];
  list.push(new JupiterAdapter());
  if (process.env.ZEROX_API_KEY) {
    list.push(new ZeroExAdapter({ chain: 'base', apiKey: process.env.ZEROX_API_KEY }));
  }
  if (process.env.ONEINCH_API_KEY) {
    list.push(new OneInchAdapter({ chain: 'base', apiKey: process.env.ONEINCH_API_KEY }));
  }
  return list;
}

function intEnv(key: string, fallback: number): number {
  const v = Number.parseInt(process.env[key] ?? '', 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}
function floatEnv(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  const v = Number.parseFloat(raw);
  return Number.isFinite(v) ? v : fallback;
}

function resolveMode(): TradeMode {
  const raw = (process.env.V2_MODE ?? 'observe').toLowerCase();
  if (raw === 'observe' || raw === 'paper' || raw === 'live') return raw;
  console.warn(`[v2] invalid V2_MODE="${raw}", defaulting to observe`);
  return 'observe';
}

export async function initV2Pipeline(): Promise<PipelineState> {
  if (instance) return instance;
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const maxPairs = intEnv('V2_MAX_PAIRS', 10);
    const sizeUsd = floatEnv('V2_SIZE_USD', 100);
    const intervalMs = intEnv('V2_INTERVAL_MS', 5000);
    const minNetUsd = floatEnv('V2_MIN_NET_USD', DEFAULT_RISK_LIMITS.minNetUsd);
    const minNetBps = floatEnv('V2_MIN_NET_BPS', DEFAULT_RISK_LIMITS.minNetBps);
    const maxTradeUsd = floatEnv('V2_MAX_TRADE_USD', 5);
    const mode = resolveMode();

    const adapters = buildAdapters();
    const discovered = await getActivePairs().catch((e: unknown) => {
      console.error(`[v2] pair discovery failed, using fallback: ${(e as Error).message}`);
      return [] as string[];
    });
    const fallback = ['BTC-USD', 'ETH-USD', 'SOL-USD'];
    const pairList = (discovered.length > 0 ? discovered : fallback).slice(0, maxPairs);
    const pairs: ObservePair[] = pairList.map((pair) => ({
      pair,
      sizeUsd,
      baseAmountForSellSide: '1',
      quoteAmountForBuySide: sizeUsd.toString(),
    }));

    const channel = new ObservableChannel();
    const observer = new ObserveEngine({
      pairs,
      adapters,
      channel,
      intervalMs,
      minNetUsd,
      minNetBps,
      log: (m) => console.log(`[v2-observer] ${m}`),
    });
    const daemon = new TradeDaemon({
      channel,
      mode,
      pollIntervalMs: Math.max(1000, Math.floor(intervalMs / 2)),
      batchSize: 10,
      risk: { minNetUsd, minNetBps, maxTradeUsd },
      executors: executors.length > 0 ? [...executors] : undefined,
      log: (m) => console.log(`[v2-trader] ${m}`),
    });

    observer.start();
    daemon.start();
    const startedAt = Date.now();
    console.log(
      `[v2] pipeline started mode=${mode} pairs=${pairList.length} adapters=${adapters.map((a) => a.venue).join(',')} executors=${executors.length}`,
    );

    instance = {
      adapters,
      channel,
      observer,
      daemon,
      pairs: pairList,
      mode,
      startedAt,
      lastRefreshAt: startedAt,
    };
    return instance;
  })();
  return initPromise;
}

export function v2Snapshot(): V2PipelineSnapshot | null {
  if (!instance) return null;
  return {
    mode: instance.mode,
    pairs: instance.pairs,
    adapters: instance.adapters.map((a) => a.venue),
    health: instance.observer.snapshotHealth(),
    recentOpportunities: [...instance.channel.published],
    recentDecisions: [...instance.channel.decisions],
    circuit: instance.daemon.getCircuit().status(),
    startedAt: instance.startedAt,
    lastRefreshAt: instance.lastRefreshAt,
  };
}

export async function stopV2Pipeline(): Promise<void> {
  if (!instance) return;
  instance.observer.stop();
  instance.daemon.stop();
  instance = null;
  initPromise = null;
}
