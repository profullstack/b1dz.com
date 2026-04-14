/**
 * EVM receipt tracker (PRD §29 Phase 3).
 *
 * Polls `eth_getTransactionReceipt` until the tx lands or the tracker
 * times out, then classifies the outcome so the trade daemon can
 * decide whether to mark the trade filled, retry, or trip a kill
 * switch (PRD §25.3).
 *
 * Keeps the polling loop pure by letting the caller inject:
 *   - a PublicClient-shaped `getTransactionReceipt` function
 *   - a sleep function (so tests can step time without real waits)
 *   - a clock (so tests can assert timeout behavior deterministically)
 *
 * Failure taxonomy mirrors the trade daemon's expectations: the
 * `status` on a receipt either succeeded or reverted, and "pending
 * forever" is surfaced as a distinct timeout so kill-switch logic can
 * tell a stuck tx from a reverted one.
 */

import type { Address, Hex, PublicClient } from 'viem';

export type ReceiptOutcome =
  | { kind: 'success'; blockNumber: bigint; gasUsed: bigint; effectiveGasPrice: bigint }
  | { kind: 'reverted'; blockNumber: bigint; gasUsed: bigint; reason: string | null }
  | { kind: 'timeout'; elapsedMs: number };

export interface TrackReceiptArgs {
  client: Pick<PublicClient, 'getTransactionReceipt'>;
  txHash: Hex;
  /** Poll interval. Default 2 000 ms — most chains confirm within a
   *  couple blocks; tighter polling just wastes RPC credits. */
  pollIntervalMs?: number;
  /** Hard timeout. Default 120 000 ms. After this the tracker returns
   *  a `timeout` outcome; caller decides what to do with stuck tx. */
  timeoutMs?: number;
  /** Sleep injection for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Clock injection for tests. */
  now?: () => number;
}

/**
 * Block until the receipt is available or the timeout fires. Returns
 * a structured outcome — never throws for normal revert/pending cases
 * (those surface as `reverted` / `timeout`). Only throws for
 * transport-level errors the caller can't handle.
 */
export async function trackReceipt(args: TrackReceiptArgs): Promise<ReceiptOutcome> {
  const pollIntervalMs = args.pollIntervalMs ?? 2_000;
  const timeoutMs = args.timeoutMs ?? 120_000;
  const now = args.now ?? (() => Date.now());
  const sleep = args.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const startedAt = now();

  while (true) {
    const elapsed = now() - startedAt;
    if (elapsed >= timeoutMs) {
      return { kind: 'timeout', elapsedMs: elapsed };
    }
    let receipt: Awaited<ReturnType<PublicClient['getTransactionReceipt']>> | null = null;
    try {
      receipt = await args.client.getTransactionReceipt({ hash: args.txHash });
    } catch (e) {
      // viem throws `TransactionReceiptNotFoundError` while the tx is
      // still pending — treat any not-found-shaped error as "keep
      // polling". Other errors bubble.
      if (!isReceiptNotFound(e)) throw e;
    }
    if (receipt) {
      return classifyReceipt(receipt);
    }
    await sleep(pollIntervalMs);
  }
}

function isReceiptNotFound(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false;
  const name = (e as { name?: string }).name ?? '';
  const msg = (e as { message?: string }).message ?? '';
  return /ReceiptNotFound|not be found|could not be found/i.test(name + ' ' + msg);
}

interface MinimalReceipt {
  status: 'success' | 'reverted' | 0 | 1 | '0x0' | '0x1';
  blockNumber: bigint;
  gasUsed: bigint;
  effectiveGasPrice?: bigint;
}

export function classifyReceipt(receipt: unknown): ReceiptOutcome {
  const r = receipt as MinimalReceipt;
  const succeeded = r.status === 'success' || r.status === 1 || r.status === '0x1';
  if (succeeded) {
    return {
      kind: 'success',
      blockNumber: r.blockNumber,
      gasUsed: r.gasUsed,
      effectiveGasPrice: r.effectiveGasPrice ?? 0n,
    };
  }
  return {
    kind: 'reverted',
    blockNumber: r.blockNumber,
    gasUsed: r.gasUsed,
    // eth_getTransactionReceipt doesn't expose revert reason directly;
    // reasons come from a separate eth_call replay. Keep the field so
    // the caller can enrich later.
    reason: null,
  };
}

/**
 * Classify a receipt outcome into a terminal status the trade daemon
 * or event channel uses (mirror the `OpportunityStatus` vocabulary).
 */
export type TerminalTxStatus = 'filled' | 'reverted' | 'stuck';
export function outcomeToStatus(outcome: ReceiptOutcome): TerminalTxStatus {
  switch (outcome.kind) {
    case 'success': return 'filled';
    case 'reverted': return 'reverted';
    case 'timeout': return 'stuck';
  }
}

/** Helper for callers that also want a one-liner describing the outcome. */
export function describeOutcome(txHash: Hex, outcome: ReceiptOutcome, from?: Address): string {
  const actor = from ? `${from.slice(0, 6)}…${from.slice(-4)} ` : '';
  switch (outcome.kind) {
    case 'success':
      return `${actor}${txHash.slice(0, 10)}… filled in block ${outcome.blockNumber} gas=${outcome.gasUsed}`;
    case 'reverted':
      return `${actor}${txHash.slice(0, 10)}… reverted in block ${outcome.blockNumber}`;
    case 'timeout':
      return `${actor}${txHash.slice(0, 10)}… stuck after ${outcome.elapsedMs}ms`;
  }
}
