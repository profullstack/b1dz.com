/**
 * Triangular arbitrage engine — v1, Uniswap V3 on Base, USDC-anchored.
 *
 * Stands alongside @b1dz/observe-engine. Rather than comparing quotes
 * from N venues for one pair, this loop enumerates cyclic routes on a
 * single venue and prices each route via the multi-hop quoter.
 *
 * Published opportunities carry `category === 'dex_triangular'` and a
 * populated `route` field. The TUI renders them as `A→B→C→A` rows. No
 * executor ships in MVP — opportunities flow through the trade-daemon
 * and get rejected ("no executor can handle category=dex_triangular"),
 * which is the intended safe paper-mode behavior.
 *
 * Why a separate engine instead of extending ObserveEngine:
 *   - Different quote shape (multi-hop path, single RPC per route) means
 *     pair-based fan-out doesn't apply.
 *   - Independent tick cadence — triangular quotes are RPC-heavy (one
 *     simulateContract per route) and shouldn't share a budget with the
 *     pair observer.
 */

import type { EventChannel } from '@b1dz/event-channel';
import type { Address } from 'viem';
import {
  buildTriangularOpportunity,
  type Opportunity,
  type TriangularRoute,
} from '@b1dz/venue-types';
import type { EvmChain, GasOracle } from '@b1dz/adapters-evm';
import { enumerateTriangles, triangleLabel, type Triangle } from './enumerator.js';
import { priceTriangle, type PricedTriangle } from './pricer.js';

export { enumerateTriangles, triangleLabel, type Triangle } from './enumerator.js';
export { priceTriangle, type PricedTriangle, type PriceTriangleArgs } from './pricer.js';

export interface TriangularEngineConfig {
  chain: EvmChain;
  /** viem PublicClient bound to `chain`. Typed as unknown at boundary. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: any;
  /** Uniswap V3 QuoterV2 address on the chain. */
  quoter: Address;
  /** Anchor symbol (MVP: "USDC"). */
  anchor: string;
  /** Non-anchor symbols to enumerate through. */
  tokens: readonly string[];
  /** Anchor-denominated input size per triangle, decimal string. */
  amountInDecimal: string;
  /** Single fee tier applied to every hop. MVP: 3000 (0.3%). */
  feeTier: number;
  gasOracle: GasOracle;
  nativeUsd: () => Promise<number> | number;
  channel: EventChannel;
  /** Loop tick interval in ms. Default 10_000. */
  intervalMs?: number;
  /** Minimum net USD required to publish. Default 0.01. */
  minNetUsd?: number;
  /** TTL of each published opportunity. Default 10_000. */
  publishTtlMs?: number;
  /** Sink for structured logs. Defaults to console.log. */
  log?: (msg: string) => void;
  /** Clock injection for tests. */
  now?: () => number;
  /** Max triangles priced per tick. Protects RPC budget; 0 = unlimited.
   *  Default 40. */
  maxPerTick?: number;
}

export interface TriangularTickResult {
  startedAt: number;
  durationMs: number;
  triangles: number;
  priced: number;
  published: number;
  topNetUsd: number;
}

export class TriangularEngine {
  private readonly cfg: TriangularEngineConfig;
  private readonly triangles: Triangle[];
  private readonly log: (msg: string) => void;
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private cursor = 0;

  constructor(cfg: TriangularEngineConfig) {
    this.cfg = cfg;
    this.triangles = enumerateTriangles(cfg.anchor, [cfg.anchor, ...cfg.tokens]);
    this.log = cfg.log ?? ((m) => console.log(m));
    this.now = cfg.now ?? (() => Date.now());
  }

  triangleCount(): number {
    return this.triangles.length;
  }

  async tick(): Promise<TriangularTickResult> {
    const startedAt = this.now();
    const maxPerTick = this.cfg.maxPerTick ?? 40;
    const budget = maxPerTick > 0 ? Math.min(maxPerTick, this.triangles.length) : this.triangles.length;

    const batch: Triangle[] = [];
    for (let i = 0; i < budget; i++) {
      batch.push(this.triangles[(this.cursor + i) % this.triangles.length]);
    }
    this.cursor = (this.cursor + budget) % this.triangles.length;

    let priced = 0;
    let published = 0;
    let topNetUsd = 0;

    const minNetUsd = this.cfg.minNetUsd ?? 0.01;
    const ttl = this.cfg.publishTtlMs ?? 10_000;

    const results = await Promise.all(
      batch.map(async (t): Promise<PricedTriangle | null> => {
        try {
          return await priceTriangle({
            triangle: t,
            chain: this.cfg.chain,
            client: this.cfg.client,
            quoter: this.cfg.quoter,
            amountInDecimal: this.cfg.amountInDecimal,
            feeTier: this.cfg.feeTier,
            gasOracle: this.cfg.gasOracle,
            nativeUsd: this.cfg.nativeUsd,
          });
        } catch (e) {
          this.log(`[triangular] price ${triangleLabel(t)} FAILED ${(e as Error).message.slice(0, 120)}`);
          return null;
        }
      }),
    );

    for (const res of results) {
      if (!res) continue;
      priced++;
      if (res.expectedNetUsd > topNetUsd) topNetUsd = res.expectedNetUsd;
      if (res.expectedNetUsd < minNetUsd) continue;

      const opp = this.buildOpp(res);
      try {
        await this.cfg.channel.publish(opp, { ttlMs: ttl });
        published++;
      } catch (e) {
        this.log(`[triangular] publish FAILED ${(e as Error).message.slice(0, 120)}`);
      }
    }

    return {
      startedAt,
      durationMs: this.now() - startedAt,
      triangles: batch.length,
      priced,
      published,
      topNetUsd,
    };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.log(`[triangular] start triangles=${this.triangles.length} interval=${this.cfg.intervalMs ?? 10_000}ms`);
    const loop = async () => {
      if (!this.running) return;
      try {
        const r = await this.tick();
        this.log(
          `[triangular] tick scanned=${r.triangles} priced=${r.priced} published=${r.published} top=$${r.topNetUsd.toFixed(4)} dur=${r.durationMs}ms`,
        );
      } catch (e) {
        this.log(`[triangular] tick FAILED ${(e as Error).message.slice(0, 120)}`);
      }
    };
    void loop();
    this.timer = setInterval(loop, this.cfg.intervalMs ?? 10_000);
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.log('[triangular] stop');
  }

  private buildOpp(res: PricedTriangle): Opportunity {
    const route: TriangularRoute = {
      chain: this.cfg.chain,
      venue: 'uniswap-v3',
      hops: res.hops,
      amountIn: res.amountInDecimal,
      amountOut: res.amountOutDecimal,
      path: res.path,
    };
    return buildTriangularOpportunity({
      id: `triangular:${this.cfg.chain}:${triangleLabel(res.triangle)}`,
      sizeUsd: res.amountInUsd.toString(),
      route,
      amountInUsd: res.amountInUsd,
      amountOutUsd: res.amountOutUsd,
      gasUsd: res.gasUsd,
    });
  }
}
