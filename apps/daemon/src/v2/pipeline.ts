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
import {
  ZeroExAdapter,
  OneInchAdapter,
  UniswapV3Adapter,
  ViemGasOracle,
  createPublicClient,
  http,
  base as baseChain,
  type PublicClient,
} from '@b1dz/adapters-evm';
import { JupiterAdapter } from '@b1dz/adapters-solana';
import { TriangularEngine } from '@b1dz/triangular-engine';
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
import { maybeBuildUniswapV3BaseExecutor, maybeBuildCexCexExecutor } from '../executors/factory.js';

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
  triangular: TriangularEngine | null;
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
    console.warn('[arb] registerExecutor called after pipeline start — ignored');
    return;
  }
  executors.push(executor);
}

function buildAdapters(): VenueAdapter[] {
  const list: VenueAdapter[] = [...defaultCexAdapters()];
  list.push(new JupiterAdapter());
  if (process.env.BASE_RPC_URL) {
    list.push(new UniswapV3Adapter({ chain: 'base' }));
  }
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
  const raw = (process.env.ARB_MODE ?? process.env.V2_MODE ?? 'observe').toLowerCase();
  if (raw === 'observe' || raw === 'paper' || raw === 'live') return raw;
  console.warn(`[arb] invalid ARB_MODE="${raw}", defaulting to observe`);
  return 'observe';
}

export async function initV2Pipeline(): Promise<PipelineState> {
  if (instance) return instance;
  if (initPromise) return initPromise;
  initPromise = (async () => {
    try {
    const maxPairs = intEnv('ARB_MAX_PAIRS', intEnv('V2_MAX_PAIRS', 10));
    const sizeUsd = floatEnv('ARB_SIZE_USD', floatEnv('V2_SIZE_USD', 100));
    const intervalMs = intEnv('ARB_INTERVAL_MS', intEnv('V2_INTERVAL_MS', 5000));
    const minNetUsd = floatEnv('ARB_MIN_NET_USD', floatEnv('V2_MIN_NET_USD', DEFAULT_RISK_LIMITS.minNetUsd));
    const minNetBps = floatEnv('ARB_MIN_NET_BPS', floatEnv('V2_MIN_NET_BPS', DEFAULT_RISK_LIMITS.minNetBps));
    const maxTradeUsd = floatEnv('ARB_MAX_TRADE_USD', floatEnv('V2_MAX_TRADE_USD', 5));
    const mode = resolveMode();

    // Build any env-armed executors before TradeDaemon is constructed —
    // TradeDaemon captures its executor list at construction time, so
    // later `registerExecutor()` calls are ignored.
    const armedExecutor = await maybeBuildUniswapV3BaseExecutor().catch((e: unknown) => {
      console.error(`[arb] executor init failed: ${(e as Error).message}`);
      return null;
    });
    if (armedExecutor && !executors.includes(armedExecutor)) {
      executors.push(armedExecutor);
    }
    const cexCexExecutor = maybeBuildCexCexExecutor();
    if (cexCexExecutor && !executors.includes(cexCexExecutor)) {
      executors.push(cexCexExecutor);
    }

    const adapters = buildAdapters();
    const discovered = await getActivePairs().catch((e: unknown) => {
      console.error(`[arb] pair discovery failed, using fallback: ${(e as Error).message}`);
      return [] as string[];
    });
    const fallback = ['BTC-USD', 'ETH-USD', 'SOL-USD'];

    // DEX-native pairs that the CEX-centric discovery won't surface.
    // Injected ahead of CEX pairs so they survive the maxPairs slice and
    // actually reach the DEX adapters. Override via ARB_DEX_PAIRS env
    // (comma-separated, canonical "BASE-QUOTE" format).
    const dexPairsRaw = process.env.ARB_DEX_PAIRS ?? 'WETH-USDC,cbBTC-USDC,WIF-USDC,BONK-USDC,JUP-USDC';
    const dexPairs = dexPairsRaw.split(',').map((s) => s.trim()).filter(Boolean);

    const combined = [...new Set([...dexPairs, ...(discovered.length > 0 ? discovered : fallback)])];
    const pairList = combined.slice(0, maxPairs);
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
      log: (m) => console.log(`[arb-observer] ${m}`),
    });
    const daemon = new TradeDaemon({
      channel,
      mode,
      pollIntervalMs: Math.max(1000, Math.floor(intervalMs / 2)),
      batchSize: 10,
      risk: { minNetUsd, minNetBps, maxTradeUsd },
      executors: executors.length > 0 ? [...executors] : undefined,
      log: (m) => console.log(`[arb-trader] ${m}`),
    });

    const triangular = maybeBuildTriangularEngine(channel);

    observer.start();
    daemon.start();
    if (triangular) triangular.start();
    const startedAt = Date.now();
    console.log(
      `[arb] pipeline started mode=${mode} pairs=${pairList.length} adapters=${adapters.map((a) => a.venue).join(',')} executors=${executors.length} triangular=${triangular ? triangular.triangleCount() : 'off'}`,
    );

    instance = {
      adapters,
      channel,
      observer,
      daemon,
      triangular,
      pairs: pairList,
      mode,
      startedAt,
      lastRefreshAt: startedAt,
    };
    return instance;
    } catch (e) {
      // Reset so the next tick can retry rather than returning a stale rejection.
      initPromise = null;
      throw e;
    }
  })();
  return initPromise;
}

/** Build a TriangularEngine if the env says so and Base RPC is available.
 *
 *  Enabling requires both:
 *    ARB_TRIANGULAR=true       explicit opt-in
 *    BASE_RPC_URL              RPC reachable for QuoterV2 calls
 *
 *  Tunables (all optional, safe defaults):
 *    ARB_TRIANGULAR_ANCHOR     default USDC
 *    ARB_TRIANGULAR_SIZE_USD   default 100
 *    ARB_TRIANGULAR_FEE_TIER   default 3000 (0.3%)
 *    ARB_TRIANGULAR_INTERVAL_MS default 10000
 *    ARB_TRIANGULAR_MIN_NET_USD default 0.05
 *    ARB_TRIANGULAR_MAX_PER_TICK default 40
 *    ARB_TRIANGULAR_TOKENS     comma-separated symbol list, default
 *                              WETH,cbBTC,AERO,DEGEN,BRETT,TOSHI,DAI
 *    ETH_USD_HINT              numeric ETH→USD for gas math, default 2500
 */
function maybeBuildTriangularEngine(channel: ObservableChannel): TriangularEngine | null {
  if ((process.env.ARB_TRIANGULAR ?? '').toLowerCase() !== 'true') return null;
  const rpcUrl = process.env.BASE_RPC_URL;
  if (!rpcUrl) {
    console.warn('[arb] ARB_TRIANGULAR=true but BASE_RPC_URL missing — triangular engine disabled');
    return null;
  }

  const addresses = UniswapV3Adapter.addressesFor('base');
  if (!addresses) {
    console.warn('[arb] triangular: no Uniswap V3 addresses for base — engine disabled');
    return null;
  }

  const client = createPublicClient({ chain: baseChain, transport: http(rpcUrl) }) as PublicClient;
  const gasOracle = new ViemGasOracle({ clients: { base: client } });

  const anchor = process.env.ARB_TRIANGULAR_ANCHOR ?? 'USDC';
  const amountInDecimal = process.env.ARB_TRIANGULAR_SIZE_USD ?? '100';
  const feeTier = Number.parseInt(process.env.ARB_TRIANGULAR_FEE_TIER ?? '3000', 10);
  const intervalMs = Number.parseInt(process.env.ARB_TRIANGULAR_INTERVAL_MS ?? '10000', 10);
  const minNetUsd = Number.parseFloat(process.env.ARB_TRIANGULAR_MIN_NET_USD ?? '0.05');
  const maxPerTick = Number.parseInt(process.env.ARB_TRIANGULAR_MAX_PER_TICK ?? '40', 10);
  const tokensEnv = process.env.ARB_TRIANGULAR_TOKENS ?? 'WETH,cbBTC,AERO,DEGEN,BRETT,TOSHI,DAI';
  const tokens = tokensEnv.split(',').map((s) => s.trim()).filter(Boolean);
  const ethUsd = Number.parseFloat(process.env.ETH_USD_HINT ?? '2500');

  return new TriangularEngine({
    chain: 'base',
    client,
    quoter: addresses.quoter,
    anchor,
    tokens,
    amountInDecimal,
    feeTier,
    gasOracle,
    nativeUsd: () => ethUsd,
    channel,
    intervalMs,
    minNetUsd,
    maxPerTick,
    log: (m) => console.log(`[arb] ${m}`),
  });
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
