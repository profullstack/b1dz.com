/**
 * Streaming observe engine (PRD §11A.1).
 *
 * Continuous loop that:
 *   1. Fetches buy + sell quotes from every adapter for each configured
 *      pair
 *   2. Ranks cross-venue opportunities through the profitability engine
 *   3. Publishes executable opportunities to the event channel for the
 *      trade daemon to consume
 *   4. Tracks per-venue health and latency metrics
 *
 * Never executes trades — that's the daemon's job.
 */

import type { VenueAdapter, QuoteRequest, NormalizedQuote, Opportunity } from '@b1dz/venue-types';
import { rankCrossVenueOpportunities } from '@b1dz/profitability';
import type { EventChannel } from '@b1dz/event-channel';

export interface ObservePair {
  /** Canonical pair, e.g. "ETH-USDC". */
  pair: string;
  /** Trade notional in USD used to size the ranking. */
  sizeUsd: number;
  /** Base-asset amount used when fetching sell-side quotes. Adapter
   *  converts this via its own decimals. */
  baseAmountForSellSide: string;
  /** Quote-asset amount used when fetching buy-side quotes. */
  quoteAmountForBuySide: string;
  /** Max slippage in bps the adapter should quote for. */
  maxSlippageBps?: number;
}

export interface ObserveConfig {
  pairs: ObservePair[];
  adapters: VenueAdapter[];
  channel: EventChannel;
  /** Tick interval in ms. Default 3000. */
  intervalMs?: number;
  /** Minimum USD net edge to publish. Below this, opportunity is logged
   *  but not queued for the daemon. Default 0. */
  minNetUsd?: number;
  /** Minimum bps net edge to publish. Default 0. */
  minNetBps?: number;
  /** TTL for each published opportunity in ms. Default 5000. */
  publishTtlMs?: number;
  /** Logger sink. Defaults to console.log. */
  log?: (msg: string) => void;
  /** Clock injection for tests. */
  now?: () => number;
}

export interface AdapterHealthMetric {
  venue: string;
  okCount: number;
  errCount: number;
  lastLatencyMs: number | null;
  lastError: string | null;
}

export interface TickResult {
  tickStartedAt: number;
  tickDurationMs: number;
  quotesFetched: number;
  opportunitiesRanked: number;
  opportunitiesPublished: number;
  healthByVenue: Record<string, AdapterHealthMetric>;
}

export class ObserveEngine {
  private readonly pairs: ObservePair[];
  private readonly adapters: VenueAdapter[];
  private readonly channel: EventChannel;
  private readonly intervalMs: number;
  private readonly minNetUsd: number;
  private readonly minNetBps: number;
  private readonly publishTtlMs: number;
  private readonly log: (msg: string) => void;
  private readonly now: () => number;
  private readonly health = new Map<string, AdapterHealthMetric>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(cfg: ObserveConfig) {
    this.pairs = cfg.pairs;
    this.adapters = cfg.adapters;
    this.channel = cfg.channel;
    this.intervalMs = cfg.intervalMs ?? 3000;
    this.minNetUsd = cfg.minNetUsd ?? 0;
    this.minNetBps = cfg.minNetBps ?? 0;
    this.publishTtlMs = cfg.publishTtlMs ?? 5000;
    this.log = cfg.log ?? ((m) => console.log(m));
    this.now = cfg.now ?? (() => Date.now());
    for (const a of this.adapters) {
      this.health.set(a.venue, { venue: a.venue, okCount: 0, errCount: 0, lastLatencyMs: null, lastError: null });
    }
  }

  /** Run one tick synchronously (no interval). Primarily for tests and
   *  one-shot observation commands. */
  async tick(): Promise<TickResult> {
    const tickStartedAt = this.now();
    const quotes: NormalizedQuote[] = [];
    let opportunitiesRanked = 0;
    let opportunitiesPublished = 0;

    for (const pair of this.pairs) {
      const [buyQuotes, sellQuotes] = await Promise.all([
        this.fetchQuotes(pair, 'buy'),
        this.fetchQuotes(pair, 'sell'),
      ]);
      quotes.push(...buyQuotes, ...sellQuotes);

      const opps = rankCrossVenueOpportunities(buyQuotes, sellQuotes, {
        tradeSizeUsd: pair.sizeUsd,
        minNetUsd: this.minNetUsd,
        minNetBps: this.minNetBps,
      });
      opportunitiesRanked += opps.length;

      for (const opp of opps) {
        if (opp.executable) {
          await this.publish(opp);
          opportunitiesPublished++;
        }
      }
    }

    const tickDurationMs = this.now() - tickStartedAt;
    return {
      tickStartedAt,
      tickDurationMs,
      quotesFetched: quotes.length,
      opportunitiesRanked,
      opportunitiesPublished,
      healthByVenue: Object.fromEntries(this.health.entries()),
    };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.log('[observe] start');
    const loop = async () => {
      if (!this.running) return;
      try {
        const r = await this.tick();
        this.log(`[observe] tick quotes=${r.quotesFetched} dur=${r.tickDurationMs}ms`);
      } catch (e) {
        this.log(`[observe] tick FAILED ${(e as Error).message.slice(0, 120)}`);
      }
    };
    // Kick the first tick immediately so the user sees activity on start.
    void loop();
    this.timer = setInterval(loop, this.intervalMs);
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.log('[observe] stop');
  }

  /** Returns a snapshot of per-venue health metrics. */
  snapshotHealth(): AdapterHealthMetric[] {
    return [...this.health.values()];
  }

  // ─── Internals ────────────────────────────────────────────────

  private async fetchQuotes(pair: ObservePair, side: 'buy' | 'sell'): Promise<NormalizedQuote[]> {
    const req: QuoteRequest = {
      pair: pair.pair,
      side,
      amountIn: side === 'buy' ? pair.quoteAmountForBuySide : pair.baseAmountForSellSide,
      maxSlippageBps: pair.maxSlippageBps,
    };
    const out: NormalizedQuote[] = [];
    await Promise.all(this.adapters.map(async (a) => {
      const metric = this.health.get(a.venue)!;
      try {
        const q = await a.quote(req);
        if (q) {
          out.push(q);
          metric.okCount++;
          metric.lastLatencyMs = q.latencyMs ?? null;
          metric.lastError = null;
        }
      } catch (e) {
        metric.errCount++;
        metric.lastError = (e as Error).message.slice(0, 200);
      }
    }));
    return out;
  }

  private async publish(opp: Opportunity): Promise<void> {
    try {
      await this.channel.publish(opp, { ttlMs: this.publishTtlMs });
    } catch (e) {
      this.log(`[observe] publish FAILED ${(e as Error).message.slice(0, 120)}`);
    }
  }
}
