/**
 * EVM gas strategy and fee-data helpers (PRD §15.3).
 *
 * Separate from any specific DEX adapter so every EVM execution path
 * shares one view of fee data, max-gas budgets, and staleness rules.
 *
 * EIP-1559 semantics:
 *   - `maxFeePerGas` is the ceiling we're willing to pay per gas.
 *     Includes the priority tip — pre-EIP-1559 this would just be
 *     `gasPrice`.
 *   - `maxPriorityFeePerGas` is the tip to the proposer.
 *   - `baseFeePerGas` is the current block's base fee; next block's
 *     base fee is derived from it + current block fullness, but we
 *     just pass it through for observability.
 *
 * This module intentionally does *not* fetch native-token USD prices —
 * that lives in whatever pricing service the profitability engine uses.
 * Keeps gas.ts pure math against observed fee data.
 */

import type { PublicClient } from 'viem';
import type { EvmChain } from './tokens.js';

export interface FeeData {
  chain: EvmChain;
  /** wei per gas — the max we'll pay including tip. */
  maxFeePerGas: bigint;
  /** wei per gas — the proposer tip. */
  maxPriorityFeePerGas: bigint;
  /** wei per gas — the base fee from the latest block when observed. */
  baseFeePerGas: bigint;
  /** ms since epoch — used for staleness rejection. */
  observedAt: number;
}

export interface GasOracle {
  getFeeData(chain: EvmChain): Promise<FeeData>;
}

/**
 * Fee-data oracle backed by a viem PublicClient. The client is
 * responsible for chain selection; this oracle just calls
 * `estimateFeesPerGas()` + reads the latest block's base fee.
 *
 * For chains where viem hasn't implemented EIP-1559 estimation (BNB
 * pre-hardfork), viem falls back to legacy gasPrice and we surface
 * that as `maxFeePerGas` with a zero tip. Callers that care about the
 * tip specifically should check `maxPriorityFeePerGas === 0n`.
 */
export class ViemGasOracle implements GasOracle {
  private readonly clients: Partial<Record<EvmChain, PublicClient>>;
  private readonly now: () => number;
  private readonly cacheTtlMs: number;
  private readonly cache: Map<EvmChain, FeeData> = new Map();
  private readonly inflight: Map<EvmChain, Promise<FeeData>> = new Map();

  constructor(opts: {
    clients: Partial<Record<EvmChain, PublicClient>>;
    /** Clock injection for tests. */
    now?: () => number;
    /** How long a cached FeeData is considered fresh. Default 10 000 ms —
     *  block time on most chains is 1-12 s, so 10 s absorbs ~1 block
     *  without stealing edge from the profitability engine. 0 disables
     *  caching entirely. */
    cacheTtlMs?: number;
  }) {
    this.clients = opts.clients;
    this.now = opts.now ?? (() => Date.now());
    this.cacheTtlMs = opts.cacheTtlMs ?? 10_000;
  }

  async getFeeData(chain: EvmChain): Promise<FeeData> {
    const client = this.clients[chain];
    if (!client) {
      throw new Error(`ViemGasOracle: no PublicClient wired for chain ${chain}`);
    }
    if (this.cacheTtlMs > 0) {
      const cached = this.cache.get(chain);
      if (cached && this.now() - cached.observedAt <= this.cacheTtlMs) {
        return cached;
      }
      const pending = this.inflight.get(chain);
      if (pending) return pending;
    }

    const fetchP = this.fetchFresh(client, chain);
    if (this.cacheTtlMs > 0) {
      this.inflight.set(chain, fetchP);
      try {
        const fee = await fetchP;
        this.cache.set(chain, fee);
        return fee;
      } finally {
        this.inflight.delete(chain);
      }
    }
    return fetchP;
  }

  /** Force the next `getFeeData()` call to skip cache. Use after we
   *  see a tx fail with "fee too low" — the cached numbers are stale. */
  invalidate(chain?: EvmChain): void {
    if (chain) this.cache.delete(chain);
    else this.cache.clear();
  }

  private async fetchFresh(client: PublicClient, chain: EvmChain): Promise<FeeData> {
    const [fees, block] = await Promise.all([
      client.estimateFeesPerGas(),
      client.getBlock({ blockTag: 'latest' }),
    ]);
    return {
      chain,
      maxFeePerGas: fees.maxFeePerGas ?? fees.gasPrice ?? 0n,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas ?? 0n,
      baseFeePerGas: block.baseFeePerGas ?? 0n,
      observedAt: this.now(),
    };
  }
}

/**
 * Cost of a transaction in USD, using the ceiling (`maxFeePerGas` ×
 * gasLimit). Overestimates on purpose — profitability checks should
 * be conservative with gas so surprise base-fee spikes don't flip a
 * +EV trade into -EV in production.
 */
export function estimateTxCostUsd(
  fee: FeeData,
  gasLimit: bigint,
  nativeUsd: number,
  opts: { bufferBps?: number } = {},
): number {
  if (gasLimit <= 0n) return 0;
  if (!Number.isFinite(nativeUsd) || nativeUsd <= 0) {
    throw new Error('nativeUsd must be a positive finite number');
  }
  const bufferBps = opts.bufferBps ?? 0;
  const weiCost = fee.maxFeePerGas * gasLimit;
  // Scale into USD using float — gas is a few $ range; precision is fine.
  const nativeCost = Number(weiCost) / 1e18;
  const raw = nativeCost * nativeUsd;
  return raw * (1 + bufferBps / 10_000);
}

export function isFeeDataStale(
  fee: FeeData,
  maxAgeMs: number,
  now: number = Date.now(),
): boolean {
  return now - fee.observedAt > maxAgeMs;
}

/**
 * Return null if the cost is acceptable, or a human-readable blocker
 * string matching the shape the profitability engine already emits.
 */
export function exceedsGasBudget(costUsd: number, maxGasUsd: number): string | null {
  if (costUsd > maxGasUsd) {
    return `gas $${costUsd.toFixed(4)} > max $${maxGasUsd}`;
  }
  return null;
}

/**
 * Reject gas cost that's disproportionately large relative to the
 * expected edge. PRD §20.2: "gas too high relative to trade size".
 */
export function gasEatsTheEdge(
  gasUsd: number,
  edgeUsd: number,
  maxRatio: number = 0.5,
): string | null {
  if (edgeUsd <= 0) return 'no edge to cover gas';
  if (gasUsd / edgeUsd > maxRatio) {
    return `gas $${gasUsd.toFixed(4)} > ${(maxRatio * 100).toFixed(0)}% of edge $${edgeUsd.toFixed(4)}`;
  }
  return null;
}

/**
 * Detect abnormal base-fee spikes relative to a rolling baseline. Use
 * this to flip into conservative mode (or pause live execution) during
 * chain congestion. Caller owns the baseline; this is a pure comparator.
 */
export function isGasSpike(
  current: FeeData,
  baseline: FeeData,
  spikeRatio: number = 2.0,
): boolean {
  if (baseline.baseFeePerGas === 0n) return false;
  const cur = Number(current.baseFeePerGas);
  const base = Number(baseline.baseFeePerGas);
  return cur / base >= spikeRatio;
}
