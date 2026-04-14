/**
 * Nonce manager (PRD §15.1).
 *
 * EVM transactions need monotonically increasing nonces per
 * (chain, address). If two in-flight txes get the same nonce one
 * will be dropped by the mempool (best case) or replaced (worst case,
 * if the second has higher gas). A restart mid-flight can collide
 * with a still-pending tx because `eth_getTransactionCount(latest)`
 * returns the confirmed count, not pending.
 *
 * Strategy:
 *   - On first use per (chain, address), fetch the on-chain count
 *     using `pending` block tag — which includes our unconfirmed tx.
 *   - Track the next nonce locally and increment on each allocation.
 *   - Optional storage hook lets callers persist the current nonce
 *     (Supabase, Redis, filesystem) so a restart doesn't need to
 *     re-fetch and risk the latest vs pending race.
 */

import type { Address, PublicClient } from 'viem';
import type { EvmChain } from '@b1dz/adapters-evm';

export interface NonceStore {
  /** Return the last persisted nonce for this (chain, address), or
   *  null if we've never persisted for it. */
  load(chain: EvmChain, address: Address): Promise<number | null>;
  /** Persist the next-to-use nonce. Called after every allocation. */
  save(chain: EvmChain, address: Address, next: number): Promise<void>;
  /** Drop the persisted entry so the next allocation re-reads from
   *  chain. Called on resync after a failed broadcast or after we
   *  detect the chain advanced outside our control. */
  clear?(chain: EvmChain, address: Address): Promise<void>;
}

/** Default in-memory store — survives the process but not a restart. */
export class InMemoryNonceStore implements NonceStore {
  private readonly data = new Map<string, number>();

  async load(chain: EvmChain, address: Address): Promise<number | null> {
    return this.data.get(key(chain, address)) ?? null;
  }
  async save(chain: EvmChain, address: Address, next: number): Promise<void> {
    this.data.set(key(chain, address), next);
  }
  async clear(chain: EvmChain, address: Address): Promise<void> {
    this.data.delete(key(chain, address));
  }
}

function key(chain: EvmChain, address: Address): string {
  return `${chain}:${address.toLowerCase()}`;
}

export interface NonceManagerArgs {
  clients: Partial<Record<EvmChain, Pick<PublicClient, 'getTransactionCount'>>>;
  store?: NonceStore;
}

/**
 * Per-(chain, address) nonce allocator. Thread-safe for the trade
 * daemon's single-threaded tick loop; NOT safe across multiple daemon
 * workers sharing a store unless the store itself serializes writes.
 */
export class NonceManager {
  private readonly clients: NonceManagerArgs['clients'];
  private readonly store: NonceStore;
  private readonly cache = new Map<string, number>();
  private readonly locks = new Map<string, Promise<void>>();

  constructor(args: NonceManagerArgs) {
    this.clients = args.clients;
    this.store = args.store ?? new InMemoryNonceStore();
  }

  /** Allocate the next nonce for a submission. Increments + persists.
   *
   *  Concurrency: chains every caller's work synchronously so that
   *  two `await` slots can't both see the same cached count and
   *  double-allocate. Each caller installs its gate BEFORE yielding,
   *  so subsequent callers enqueue after it, not after the prior one. */
  async next(chain: EvmChain, address: Address): Promise<number> {
    const k = key(chain, address);
    const prev = this.locks.get(k) ?? Promise.resolve();

    let releaseMine!: () => void;
    const mine = new Promise<void>((r) => { releaseMine = r; });
    // Chain ours AFTER prev; subsequent callers will see this
    // combined promise and queue behind us.
    const chained = prev.then(() => mine).catch(() => {});
    this.locks.set(k, chained);

    try {
      await prev;
      const current = await this.resolveCurrent(chain, address);
      const nextVal = current + 1;
      this.cache.set(k, nextVal);
      await this.store.save(chain, address, nextVal);
      return current;
    } finally {
      releaseMine();
      // Only clear the head-of-queue if we're still the tail; another
      // caller may have already chained after us.
      if (this.locks.get(k) === chained) this.locks.delete(k);
    }
  }

  /** Force-resync from the chain. Call after a rejected tx or any
   *  time we suspect our cached count is stale. Clears both the
   *  in-memory cache AND the persisted store so the next allocation
   *  re-reads from chain, not from a stale persisted value. */
  async resync(chain: EvmChain, address: Address): Promise<void> {
    const k = key(chain, address);
    this.cache.delete(k);
    if (this.store.clear) {
      await this.store.clear(chain, address);
    }
  }

  private async resolveCurrent(chain: EvmChain, address: Address): Promise<number> {
    const k = key(chain, address);
    const cached = this.cache.get(k);
    if (cached !== undefined) return cached;
    const persisted = await this.store.load(chain, address);
    if (persisted !== null) {
      this.cache.set(k, persisted);
      return persisted;
    }
    const client = this.clients[chain];
    if (!client) throw new Error(`NonceManager: no client for chain ${chain}`);
    // `pending` includes our own unconfirmed txes — safer than `latest`
    // when restarting a daemon that had pending work.
    const n = await client.getTransactionCount({ address, blockTag: 'pending' });
    this.cache.set(k, n);
    return n;
  }
}
