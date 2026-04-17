/**
 * Trade engine daemon (PRD §11A.2).
 *
 * Subscribes to the event-channel queue, applies final risk + balance
 * checks, decides execute/paper/reject, and records the outcome. MVP
 * supports `observe` and `paper` modes only — live execution wires in
 * after the wallet-provider package lands (PRD §15A).
 *
 * The claim loop uses the channel's atomic claim() so multiple daemon
 * workers can share a single queue without double-processing.
 */

import type { EventChannel, QueuedOpportunity, OpportunityStatus } from '@b1dz/event-channel';
import type { ExecutionMode, Opportunity } from '@b1dz/venue-types';
import { CircuitBreaker, type CircuitConfig } from './circuit.js';

export { CircuitBreaker, DEFAULT_CIRCUIT_CONFIG, type CircuitConfig, type CircuitState, type CircuitTrip } from './circuit.js';

export type TradeMode = 'observe' | 'paper' | 'live';

// ─── Executor contract (PRD §29 Phase 3) ──────────────────────────
//
// The daemon is venue-agnostic; live execution per opportunity
// category (cex_dex, dex_dex, pumpfun_*) is delegated to an injected
// Executor. The daemon calls `canExecute(opp)` to decide whether this
// executor is the right one, then `execute(opp)` to perform the trade
// and get back a structured outcome the channel can store.

export type ExecutorOutcomeStatus = 'filled' | 'reverted' | 'stuck' | 'aborted';

export interface ExecutorOutcome {
  status: ExecutorOutcomeStatus;
  resolvedReason: string;
  /** Optional audit trail: tx hash (EVM/Solana) or order id (CEX). */
  externalId?: string;
  /** True when an executor's execute() was actually called (vs routing
   *  mismatch / inventory abort). Only real executions trip the circuit. */
  executorRan?: boolean;
}

export interface Executor {
  /** Cheap predicate — daemon uses it to pick the right executor from
   *  a list. Keep this synchronous and free of I/O. */
  canExecute(opp: Opportunity): boolean;
  /** Perform the trade. Must resolve (never throw) — serialize the
   *  error into `status: 'aborted'` with a human-readable reason. */
  execute(opp: Opportunity): Promise<ExecutorOutcome>;
}

// ─── Inventory contract ───────────────────────────────────────────
// Matches the shape of @b1dz/inventory's InventoryLedger without
// pulling the whole package as a type dep — lets tests mock cheaply.

export interface InventoryCheck {
  /** Return null to allow, or a blocker string to abort. */
  canAfford(opp: Opportunity): Promise<string | null> | string | null;
}

export interface RiskLimits {
  maxTradeUsd: number;
  maxDailyLossUsd: number;
  minNetUsd: number;
  minNetBps: number;
  maxGasUsd: number;
  maxSlippageBps: number;
  maxRouteHops: number;
  /** PRD §A14: highest execution mode this daemon can actually run.
   *  Opportunities whose recommendedExecutionMode escalates above this
   *  are rejected. `public` is the default — private/bundle require
   *  explicit infrastructure wiring. */
  executionMode: ExecutionMode;
  /** PRD §A7: reject an opportunity whose realizability score falls
   *  below this threshold. 0 disables the filter. */
  minRealizabilityScore: number;
  /** PRD §A14: reject public-flow routes whose MEV risk exceeds this
   *  threshold. Applied only when executionMode='public'. */
  rejectPublicMevAbove: number;
}

export const DEFAULT_RISK_LIMITS: RiskLimits = {
  maxTradeUsd: 100,
  maxDailyLossUsd: 100,
  minNetUsd: 2,
  minNetBps: 15,
  maxGasUsd: 5,
  maxSlippageBps: 50,
  maxRouteHops: 3,
  executionMode: 'public',
  minRealizabilityScore: 0.5,
  rejectPublicMevAbove: 0.7,
};

/** Ordering used to check whether the operator's mode can satisfy the
 *  opportunity's recommended mode. `paper_only` is the most restrictive
 *  (refuses live execution entirely); `bundle` is the most capable. */
const EXECUTION_MODE_RANK: Record<ExecutionMode, number> = {
  paper_only: 0,
  public: 1,
  private: 2,
  bundle: 3,
};

function canSatisfy(available: ExecutionMode, required: ExecutionMode): boolean {
  if (required === 'paper_only') return available === 'paper_only';
  return EXECUTION_MODE_RANK[available] >= EXECUTION_MODE_RANK[required];
}

export interface TradeDecision {
  queueId: string;
  opportunity: Opportunity;
  decision: 'execute' | 'paper' | 'reject';
  reasons: string[];
  /** Terminal status we intend to record after action. */
  terminalStatus: Exclude<OpportunityStatus, 'pending' | 'claimed'>;
  resolvedReason: string;
}

export interface TradeDaemonConfig {
  channel: EventChannel;
  mode: TradeMode;
  risk?: Partial<RiskLimits>;
  /** Identifier for this daemon worker — recorded with every claim for
   *  audit and contention tracking. */
  claimerId?: string;
  /** How often the daemon polls the queue when idle. Default 1000ms. */
  pollIntervalMs?: number;
  /** Max rows to claim per tick. Default 5. */
  batchSize?: number;
  log?: (msg: string) => void;
  /** Ordered list of executors tried in sequence; the first whose
   *  `canExecute(opp)` returns true wins. In live mode, if no executor
   *  matches, the opportunity is aborted with a clear reason rather
   *  than silently accepted. Not consulted in observe/paper modes. */
  executors?: readonly Executor[];
  /** Optional inventory check run BEFORE the executor. Aborts the
   *  trade when the daemon can't prove the wallet has the asset. */
  inventory?: InventoryCheck;
  /** Circuit breaker. If omitted, the daemon uses defaults. Pass an
   *  existing instance to share a breaker across multiple daemon
   *  workers (e.g. if you run observe-side health checks that can
   *  trip it out-of-band). */
  circuit?: CircuitBreaker;
  /** Optional: derive realized PnL from a finished trade so the
   *  circuit's daily-loss counter can update. Called after every live
   *  execution. Default returns null (no PnL tracking). */
  pnlFromOutcome?: (opp: Opportunity, outcome: ExecutorOutcome) => number | null;
}

/**
 * Evaluate whether an opportunity passes the daemon's risk gates.
 * Pure function — no I/O, easy to test exhaustively.
 */
export function decideOpportunity(
  queued: QueuedOpportunity,
  mode: TradeMode,
  risk: RiskLimits,
  now: number = Date.now(),
): TradeDecision {
  const opp = queued.opportunity;
  const reasons: string[] = [];

  // Re-verify the observer's executable flag: observer can mark an opp
  // executable but the daemon's risk profile may be stricter.
  if (!opp.executable) reasons.push('observer marked non-executable');
  if (opp.expectedNetUsd < risk.minNetUsd) reasons.push(`net $${opp.expectedNetUsd.toFixed(4)} < min $${risk.minNetUsd}`);
  if (opp.expectedNetBps < risk.minNetBps) reasons.push(`net ${opp.expectedNetBps.toFixed(1)}bps < min ${risk.minNetBps}bps`);
  if (Number.parseFloat(opp.size) > risk.maxTradeUsd) reasons.push(`size $${opp.size} > max $${risk.maxTradeUsd}`);
  if (opp.totalGasUsd > risk.maxGasUsd) reasons.push(`gas $${opp.totalGasUsd.toFixed(4)} > max $${risk.maxGasUsd}`);
  const maxSlippageBps = opp.buyQuote.slippageBps + opp.sellQuote.slippageBps;
  if (maxSlippageBps > risk.maxSlippageBps) reasons.push(`slip ${maxSlippageBps}bps > max ${risk.maxSlippageBps}bps`);
  const maxHops = Math.max(opp.buyQuote.routeHops, opp.sellQuote.routeHops);
  if (maxHops > risk.maxRouteHops) reasons.push(`hops ${maxHops} > max ${risk.maxRouteHops}`);

  // PRD §A5, §A7: execution-mode and realizability gates.
  if (opp.execution) {
    const { recommendedExecutionMode, realizabilityScore, mevRiskScore } = opp.execution;
    if (!canSatisfy(risk.executionMode, recommendedExecutionMode)) {
      reasons.push(`requires ${recommendedExecutionMode} but daemon=${risk.executionMode}`);
    }
    if (realizabilityScore < risk.minRealizabilityScore) {
      reasons.push(`realizability ${realizabilityScore.toFixed(2)} < min ${risk.minRealizabilityScore}`);
    }
    if (risk.executionMode === 'public' && mevRiskScore > risk.rejectPublicMevAbove) {
      reasons.push(`public-mode MEV risk ${mevRiskScore.toFixed(2)} > ${risk.rejectPublicMevAbove}`);
    }
  }

  // TTL: refuse to act on expired rows even if the channel somehow
  // handed one back.
  if (queued.expiresAt <= now) reasons.push('expired before claim');

  if (reasons.length > 0) {
    return {
      queueId: queued.queueId,
      opportunity: opp,
      decision: 'reject',
      reasons,
      terminalStatus: 'rejected',
      resolvedReason: reasons.join('; '),
    };
  }

  if (mode === 'observe') {
    return {
      queueId: queued.queueId,
      opportunity: opp,
      decision: 'reject',
      reasons: ['observe mode'],
      terminalStatus: 'rejected',
      resolvedReason: 'observe mode — no execution',
    };
  }
  if (mode === 'paper') {
    return {
      queueId: queued.queueId,
      opportunity: opp,
      decision: 'paper',
      reasons: [],
      terminalStatus: 'filled',
      resolvedReason: `paper fill expected=$${opp.expectedNetUsd.toFixed(4)}`,
    };
  }
  // Live mode: pass the risk gates here; real execution happens in
  // TradeDaemon.tick() via the injected Executor. Terminal status is
  // provisional; the tick loop replaces it with the real outcome.
  return {
    queueId: queued.queueId,
    opportunity: opp,
    decision: 'execute',
    reasons: [],
    terminalStatus: 'filled',
    resolvedReason: 'pending live execution',
  };
}

export class TradeDaemon {
  private readonly channel: EventChannel;
  private readonly mode: TradeMode;
  private readonly risk: RiskLimits;
  private readonly claimerId: string;
  private readonly pollIntervalMs: number;
  private readonly batchSize: number;
  private readonly log: (msg: string) => void;
  private readonly executors: readonly Executor[];
  private readonly inventory: InventoryCheck | null;
  private readonly circuit: CircuitBreaker;
  private readonly pnlFromOutcome: NonNullable<TradeDaemonConfig['pnlFromOutcome']>;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(cfg: TradeDaemonConfig) {
    this.channel = cfg.channel;
    this.mode = cfg.mode;
    this.risk = { ...DEFAULT_RISK_LIMITS, ...(cfg.risk ?? {}) };
    this.claimerId = cfg.claimerId ?? `daemon-${Math.random().toString(36).slice(2, 8)}`;
    this.pollIntervalMs = cfg.pollIntervalMs ?? 1000;
    this.batchSize = cfg.batchSize ?? 5;
    this.log = cfg.log ?? ((m) => console.log(m));
    this.executors = cfg.executors ?? [];
    this.inventory = cfg.inventory ?? null;
    this.circuit = cfg.circuit ?? new CircuitBreaker();
    this.pnlFromOutcome = cfg.pnlFromOutcome ?? (() => null);
  }

  /** Access the daemon's circuit breaker — for dashboards, external
   *  trip signals, or manual reset. */
  getCircuit(): CircuitBreaker {
    return this.circuit;
  }

  /** Process one batch of pending opportunities. Returns the decisions
   *  made this tick so callers can inspect or aggregate. */
  async tick(): Promise<TradeDecision[]> {
    const claimed = await this.channel.claim({ claimer: this.claimerId, limit: this.batchSize });
    if (claimed.length === 0) return [];
    const decisions: TradeDecision[] = [];
    for (const q of claimed) {
      const d = decideOpportunity(q, this.mode, this.risk);

      let finalStatus: TradeDecision['terminalStatus'] = d.terminalStatus;
      let finalReason = d.resolvedReason;

      // Live mode + decision=execute: run inventory check then dispatch
      // to the first matching executor. Observe/paper skip this branch.
      if (d.decision === 'execute' && this.mode === 'live') {
        const tripReason = this.circuit.canExecute();
        if (tripReason) {
          finalStatus = 'rejected';
          finalReason = tripReason;
        } else {
          const outcome = await this.runLive(d);
          finalStatus = mapExecutorStatus(outcome.status);
          finalReason = outcome.externalId
            ? `${outcome.resolvedReason} (ref=${outcome.externalId})`
            : outcome.resolvedReason;
          // Only record to circuit when an executor actually ran.
          // "No executor can handle" is a routing mismatch, not an
          // execution failure — it must not trip the circuit breaker.
          if (outcome.executorRan) {
            this.circuit.recordExecution({
              filled: outcome.status === 'filled',
              realizedPnlUsd: this.pnlFromOutcome(d.opportunity, outcome) ?? undefined,
            });
          }
        }
      }

      decisions.push({ ...d, terminalStatus: finalStatus, resolvedReason: finalReason });
      try {
        await this.channel.resolve(q.queueId, finalStatus, finalReason);
      } catch (e) {
        this.log(`[daemon] resolve FAILED ${(e as Error).message.slice(0, 120)}`);
      }
      this.log(`[daemon] ${d.decision.toUpperCase()}→${finalStatus} ${q.queueId.slice(0, 8)} ${q.opportunity.buyVenue}→${q.opportunity.sellVenue} ${q.opportunity.asset} net=$${q.opportunity.expectedNetUsd.toFixed(4)} ${d.reasons.length ? `reasons=[${d.reasons.slice(0, 2).join('; ')}]` : ''}`);
    }
    return decisions;
  }

  private async runLive(decision: TradeDecision): Promise<ExecutorOutcome> {
    const opp = decision.opportunity;

    if (this.inventory) {
      try {
        const block = await this.inventory.canAfford(opp);
        if (block) {
          return { status: 'aborted', resolvedReason: block };
        }
      } catch (e) {
        return { status: 'aborted', resolvedReason: `inventory check failed: ${(e as Error).message.slice(0, 160)}` };
      }
    }

    if (this.executors.length === 0) {
      return {
        status: 'aborted',
        resolvedReason: 'live mode enabled but no Executor wired — daemon refuses to silently skip',
      };
    }
    const executor = this.executors.find((e) => e.canExecute(opp));
    if (!executor) {
      return {
        status: 'aborted',
        resolvedReason: `no executor can handle category=${opp.category} buy=${opp.buyVenue} sell=${opp.sellVenue}`,
      };
    }
    try {
      const result = await executor.execute(opp);
      return { ...result, executorRan: true };
    } catch (e) {
      // Executor contract says execute() must not throw — this is a
      // bug on the executor side. Catch anyway to keep the tick loop
      // alive.
      return { status: 'aborted', resolvedReason: `executor threw: ${(e as Error).message.slice(0, 160)}`, executorRan: true };
    }
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.log(`[daemon] start mode=${this.mode} claimer=${this.claimerId} poll=${this.pollIntervalMs}ms`);
    const loop = async () => {
      if (!this.running) return;
      try {
        await this.tick();
      } catch (e) {
        this.log(`[daemon] tick FAILED ${(e as Error).message.slice(0, 120)}`);
      }
    };
    void loop();
    this.timer = setInterval(loop, this.pollIntervalMs);
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.log('[daemon] stop');
  }
}

/** Map an Executor's outcome status to the event-channel's terminal
 *  status vocabulary. 'stuck' maps to 'rejected' because the channel
 *  doesn't yet model "submitted but never confirmed" as distinct from
 *  "rejected pre-submit"; the tx hash lives in the resolved reason
 *  for later audit. */
function mapExecutorStatus(status: ExecutorOutcomeStatus): TradeDecision['terminalStatus'] {
  switch (status) {
    case 'filled': return 'filled';
    case 'reverted': return 'failed';
    case 'stuck': return 'failed';
    case 'aborted': return 'rejected';
  }
}
