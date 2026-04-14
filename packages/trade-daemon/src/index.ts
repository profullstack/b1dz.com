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

export type TradeMode = 'observe' | 'paper' | 'live';

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
  return {
    queueId: queued.queueId,
    opportunity: opp,
    decision: 'execute',
    reasons: [],
    terminalStatus: 'filled',
    resolvedReason: 'live execution path not yet implemented — treat as paper',
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
  }

  /** Process one batch of pending opportunities. Returns the decisions
   *  made this tick so callers can inspect or aggregate. */
  async tick(): Promise<TradeDecision[]> {
    const claimed = await this.channel.claim({ claimer: this.claimerId, limit: this.batchSize });
    if (claimed.length === 0) return [];
    const decisions: TradeDecision[] = [];
    for (const q of claimed) {
      const d = decideOpportunity(q, this.mode, this.risk);
      decisions.push(d);
      try {
        await this.channel.resolve(q.queueId, d.terminalStatus, d.resolvedReason);
      } catch (e) {
        this.log(`[daemon] resolve FAILED ${(e as Error).message.slice(0, 120)}`);
      }
      this.log(`[daemon] ${d.decision.toUpperCase()} ${q.queueId.slice(0, 8)} ${q.opportunity.buyVenue}→${q.opportunity.sellVenue} ${q.opportunity.asset} net=$${q.opportunity.expectedNetUsd.toFixed(4)} ${d.reasons.length ? `reasons=[${d.reasons.slice(0, 2).join('; ')}]` : ''}`);
    }
    return decisions;
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
