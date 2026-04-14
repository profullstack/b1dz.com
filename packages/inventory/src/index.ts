/**
 * Inventory ledger (PRD §21).
 *
 * Tracks balances the bot actually has available per
 * (venue, chain, token). The trade daemon consults this before
 * executing so it never submits a tx that would fail on insufficient
 * balance — or worse, submit a tx spending an asset parked on a CEX
 * that needs a 30-minute withdrawal to reach the hot wallet.
 *
 * MVP design:
 *   - Reads are on-demand from whatever source is authoritative
 *     (viem for EVM, RPC for Solana, API for CEX).
 *   - Ledger stores `available` / `reserved` / `pendingTx` with USD
 *     reference value. A `reserve()` call atomically decreases
 *     available + increases reserved; `release()` and `settle()`
 *     reverse / clear it.
 *   - Refresh policy is explicit — the daemon calls
 *     `refresh(venue, chain, token)` when it wants a fresh balance.
 *     Keeps the ledger honest about what's a live read vs a cached
 *     value.
 *
 * Not in MVP: automatic cross-venue rebalancing, withdrawal queueing,
 * concentrated-liquidity position tracking.
 */

import {
  parseAbi,
  type Address,
  type PublicClient,
} from 'viem';
import type { EvmChain } from '@b1dz/adapters-evm';

export type VenueKind = 'evm-wallet' | 'solana-wallet' | 'cex';

export interface InventoryKey {
  venue: string;
  chain: string;
  token: string;
}

export interface InventoryEntry extends InventoryKey {
  /** Balance available for new trades (base units as decimal string). */
  available: string;
  /** Reserved by an in-flight opportunity but not yet consumed. */
  reserved: string;
  /** In-flight tx: submitted but not yet confirmed. */
  pendingTx: string;
  /** Last time this row was refreshed from the source of truth. */
  observedAt: number;
  /** Optional USD reference, for dashboard + risk aggregation. */
  usdReference: number | null;
}

export interface BalanceSource {
  /** Whether this source owns balances for the given key. */
  supports(key: InventoryKey): boolean;
  /** Fetch the current available balance as a decimal string in base
   *  units (e.g. "1500000" for 1.5 USDC on a 6-decimal token). */
  fetchAvailable(key: InventoryKey): Promise<string>;
}

export interface ReserveArgs extends InventoryKey {
  amount: string;
}

const ERC20_BALANCE_ABI = parseAbi([
  'function balanceOf(address owner) view returns (uint256)',
]);

// ─── Built-in balance sources ─────────────────────────────────────

/**
 * EVM wallet balance source. Reads native + ERC20 balances via a
 * viem PublicClient per chain.
 */
export class EvmWalletBalanceSource implements BalanceSource {
  private readonly clients: Partial<Record<EvmChain, PublicClient>>;
  private readonly wallet: Address;
  private readonly venue: string;
  private readonly tokens: Partial<Record<string, Partial<Record<string, { address: Address; isNative: boolean }>>>>;

  constructor(opts: {
    /** `venue` label this source answers to — lets you run multiple
     *  wallets at once (e.g. 'hot-evm-base' vs 'hot-evm-avax'). */
    venue: string;
    wallet: Address;
    clients: Partial<Record<EvmChain, PublicClient>>;
    /** Per-chain token symbol → contract address map. Native assets
     *  (ETH / AVAX / POL) use `isNative: true` and any address. */
    tokens: Partial<Record<EvmChain, Partial<Record<string, { address: Address; isNative: boolean }>>>>;
  }) {
    this.venue = opts.venue;
    this.wallet = opts.wallet;
    this.clients = opts.clients;
    this.tokens = opts.tokens as typeof this.tokens;
  }

  supports(key: InventoryKey): boolean {
    if (key.venue !== this.venue) return false;
    const chainTokens = this.tokens[key.chain];
    return !!(chainTokens && chainTokens[key.token]);
  }

  async fetchAvailable(key: InventoryKey): Promise<string> {
    const client = this.clients[key.chain as EvmChain];
    if (!client) throw new Error(`EvmWalletBalanceSource: no client for ${key.chain}`);
    const chainTokens = this.tokens[key.chain];
    const token = chainTokens && chainTokens[key.token];
    if (!token) throw new Error(`EvmWalletBalanceSource: unknown token ${key.token} on ${key.chain}`);
    if (token.isNative) {
      const wei = await client.getBalance({ address: this.wallet });
      return wei.toString();
    }
    const balance = (await client.readContract({
      address: token.address,
      abi: ERC20_BALANCE_ABI,
      functionName: 'balanceOf',
      args: [this.wallet],
    })) as bigint;
    return balance.toString();
  }
}

// ─── Ledger ───────────────────────────────────────────────────────

export class InventoryLedger {
  private readonly entries = new Map<string, InventoryEntry>();
  private readonly sources: BalanceSource[];
  private readonly usdReference: (key: InventoryKey, amount: string) => number | null;

  constructor(opts: {
    sources: BalanceSource[];
    /** Optional resolver: produces a USD value for a (key, amount). */
    usdReference?: (key: InventoryKey, amount: string) => number | null;
  }) {
    this.sources = opts.sources;
    this.usdReference = opts.usdReference ?? (() => null);
  }

  /** Fetch a fresh balance from the authoritative source for this key
   *  and write it into the ledger. */
  async refresh(key: InventoryKey): Promise<InventoryEntry> {
    const source = this.sources.find((s) => s.supports(key));
    if (!source) {
      throw new Error(`InventoryLedger: no balance source for ${key.venue}/${key.chain}/${key.token}`);
    }
    const available = await source.fetchAvailable(key);
    const entry: InventoryEntry = {
      ...key,
      available,
      reserved: '0',
      pendingTx: '0',
      observedAt: Date.now(),
      usdReference: this.usdReference(key, available),
    };
    // Preserve reserved / pendingTx across a refresh — they're our
    // book-keeping, not the chain's.
    const existing = this.entries.get(ledgerKey(key));
    if (existing) {
      entry.reserved = existing.reserved;
      entry.pendingTx = existing.pendingTx;
    }
    this.entries.set(ledgerKey(key), entry);
    return entry;
  }

  get(key: InventoryKey): InventoryEntry | null {
    return this.entries.get(ledgerKey(key)) ?? null;
  }

  /** Returns null when the key is known, or a blocker string when
   *  `amount` exceeds `available - reserved - pendingTx`. */
  canAfford(key: InventoryKey, amount: string): string | null {
    const entry = this.entries.get(ledgerKey(key));
    if (!entry) return `inventory: no entry for ${key.venue}/${key.chain}/${key.token}`;
    const free = bigintSafe(entry.available) - bigintSafe(entry.reserved) - bigintSafe(entry.pendingTx);
    const need = bigintSafe(amount);
    if (free < need) {
      return `inventory: need ${amount} ${key.token}, have ${free.toString()} free on ${key.venue}/${key.chain}`;
    }
    return null;
  }

  /** Atomically move `amount` from available to reserved. Returns the
   *  updated entry. Throws if insufficient balance. */
  reserve(args: ReserveArgs): InventoryEntry {
    const k = ledgerKey(args);
    const entry = this.entries.get(k);
    if (!entry) throw new Error(`InventoryLedger: reserve on unknown key ${k}`);
    const block = this.canAfford(args, args.amount);
    if (block) throw new Error(block);
    entry.reserved = (bigintSafe(entry.reserved) + bigintSafe(args.amount)).toString();
    this.entries.set(k, entry);
    return entry;
  }

  /** Release a reservation without consuming it (e.g. opportunity
   *  rejected after reserve). */
  release(args: ReserveArgs): InventoryEntry {
    const k = ledgerKey(args);
    const entry = this.entries.get(k);
    if (!entry) throw new Error(`InventoryLedger: release on unknown key ${k}`);
    const reserved = bigintSafe(entry.reserved);
    const amt = bigintSafe(args.amount);
    if (amt > reserved) throw new Error('InventoryLedger: release exceeds reserved');
    entry.reserved = (reserved - amt).toString();
    this.entries.set(k, entry);
    return entry;
  }

  /** Move `amount` from reserved → pendingTx when broadcasting. */
  markPending(args: ReserveArgs): InventoryEntry {
    const k = ledgerKey(args);
    const entry = this.entries.get(k);
    if (!entry) throw new Error(`InventoryLedger: markPending on unknown key ${k}`);
    const reserved = bigintSafe(entry.reserved);
    const amt = bigintSafe(args.amount);
    if (amt > reserved) throw new Error('InventoryLedger: pending exceeds reserved');
    entry.reserved = (reserved - amt).toString();
    entry.pendingTx = (bigintSafe(entry.pendingTx) + amt).toString();
    this.entries.set(k, entry);
    return entry;
  }

  /** Clear pendingTx and (typically) subtract from available on
   *  confirmation. Caller passes the real consumed amount — may
   *  differ from the reserved estimate if gas or slippage shifted. */
  settle(args: ReserveArgs & { consumedFromAvailable: string }): InventoryEntry {
    const k = ledgerKey(args);
    const entry = this.entries.get(k);
    if (!entry) throw new Error(`InventoryLedger: settle on unknown key ${k}`);
    const pending = bigintSafe(entry.pendingTx);
    const amt = bigintSafe(args.amount);
    if (amt > pending) throw new Error('InventoryLedger: settle exceeds pending');
    entry.pendingTx = (pending - amt).toString();
    const avail = bigintSafe(entry.available);
    const consumed = bigintSafe(args.consumedFromAvailable);
    entry.available = (avail - consumed).toString();
    entry.observedAt = Date.now();
    this.entries.set(k, entry);
    return entry;
  }

  /** Diagnostic dump. */
  snapshot(): InventoryEntry[] {
    return Array.from(this.entries.values());
  }
}

function ledgerKey(k: InventoryKey): string {
  return `${k.venue}|${k.chain}|${k.token}`;
}

function bigintSafe(s: string): bigint {
  // Base units only — strings are always integers. Reject anything
  // with a decimal point to catch unit-conversion mistakes early.
  if (s.includes('.')) throw new Error(`inventory expected base-unit integer, got "${s}"`);
  return BigInt(s);
}
