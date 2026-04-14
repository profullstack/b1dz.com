/**
 * Solana live execution helpers (PRD §16.2, §29 Phase 4).
 *
 * Jupiter's `/swap/v1/swap` endpoint returns a serialized
 * VersionedTransaction with every signature slot zero-filled. To
 * submit it we:
 *   1. Parse the serialized bytes into (signatures, message).
 *   2. Sign the message bytes with our ed25519 key via the
 *      WalletProvider.signSolanaMessage call.
 *   3. Replace slot 0 in the signatures array with the signature.
 *   4. Re-serialize, base64-encode, submit via
 *      `sendTransaction` JSON-RPC.
 *   5. Poll `getSignatureStatuses` until confirmed or timeout.
 *
 * Zero runtime deps on @solana/web3.js — we talk raw JSON-RPC and
 * parse the wire format ourselves. The same dep-free path the
 * @b1dz/wallet-direct Solana signer uses.
 */

import type { WalletProvider } from '@b1dz/wallet-provider';
import { base58decode } from './base58.js';

export type SolanaCommitment = 'processed' | 'confirmed' | 'finalized';

export interface JupiterSwapRequest {
  /** Raw quote response body from `/swap/v1/quote`. */
  quoteResponse: unknown;
  /** The user's base58-encoded Solana public key. */
  userPublicKey: string;
  /** Optional priority fee in lamports. */
  prioritizationFeeLamports?: number | 'auto';
  /** Optional wrap/unwrap SOL. */
  wrapAndUnwrapSol?: boolean;
}

export interface JupiterSwapResponse {
  /** Base64-encoded VersionedTransaction. */
  swapTransaction: string;
  /** Last valid block height for this tx. */
  lastValidBlockHeight: number;
  prioritizationFeeLamports?: number;
}

/**
 * Fetch a prepared swap transaction from Jupiter given a prior quote.
 */
export async function fetchJupiterSwap(
  baseUrl: string,
  req: JupiterSwapRequest,
): Promise<JupiterSwapResponse> {
  const url = new URL('/swap/v1/swap', baseUrl);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      quoteResponse: req.quoteResponse,
      userPublicKey: req.userPublicKey,
      wrapAndUnwrapSol: req.wrapAndUnwrapSol ?? true,
      prioritizationFeeLamports: req.prioritizationFeeLamports ?? 'auto',
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`jupiter swap ${res.status}: ${text.slice(0, 200)}`);
  }
  return (await res.json()) as JupiterSwapResponse;
}

// ─── Versioned transaction wire-format plumbing ───────────────────
//
// Solana transaction serialization:
//   shortvec(num_sigs) || num_sigs × [64-byte signature] || message
//
// shortvec is Solana's varint — values < 128 are 1 byte; we use that
// simple path since tx signature counts are always small integers.

function readShortvec(buf: Uint8Array, at: number): { value: number; next: number } {
  let len = 0;
  let shift = 0;
  for (let i = 0; i < 3; i++) {
    const b = buf[at + i];
    if (b === undefined) throw new Error('truncated shortvec');
    len |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) return { value: len, next: at + i + 1 };
    shift += 7;
  }
  throw new Error('shortvec too long');
}

function writeShortvec(value: number): Uint8Array {
  const out: number[] = [];
  let v = value;
  while (true) {
    const lowBits = v & 0x7f;
    v >>= 7;
    if (v === 0) {
      out.push(lowBits);
      return Uint8Array.from(out);
    }
    out.push(lowBits | 0x80);
  }
}

export interface ParsedTx {
  numSignatures: number;
  signatures: Uint8Array[];
  message: Uint8Array;
}

export function parseTransaction(bytes: Uint8Array): ParsedTx {
  const { value: numSigs, next } = readShortvec(bytes, 0);
  const sigs: Uint8Array[] = [];
  let cursor = next;
  for (let i = 0; i < numSigs; i++) {
    sigs.push(bytes.subarray(cursor, cursor + 64));
    cursor += 64;
  }
  const message = bytes.subarray(cursor);
  return { numSignatures: numSigs, signatures: sigs, message };
}

export function reassembleTransaction(
  signatures: readonly Uint8Array[],
  message: Uint8Array,
): Uint8Array {
  const header = writeShortvec(signatures.length);
  const total = header.length + signatures.length * 64 + message.length;
  const out = new Uint8Array(total);
  let offset = 0;
  out.set(header, offset); offset += header.length;
  for (const sig of signatures) {
    if (sig.length !== 64) throw new Error('solana signature must be 64 bytes');
    out.set(sig, offset); offset += 64;
  }
  out.set(message, offset);
  return out;
}

// ─── Sign + send ─────────────────────────────────────────────────

export interface SubmitArgs {
  /** Base64-encoded VersionedTransaction with all sig slots zero-filled. */
  swapTransactionB64: string;
  walletProvider: WalletProvider;
  /** Solana RPC endpoint (JSON-RPC 2.0). */
  rpcUrl: string;
  /** How many preflight simulations before refusing. Default: enabled
   *  unless the caller explicitly disables. */
  skipPreflight?: boolean;
  /** Max retries viem-style — Solana node will retry internally. */
  maxRetries?: number;
}

export async function signAndSendJupiterTx(args: SubmitArgs): Promise<string> {
  const raw = base64ToBytes(args.swapTransactionB64);
  const parsed = parseTransaction(raw);
  if (parsed.numSignatures < 1) {
    throw new Error('jupiter tx has no signature slots — expected at least one for the user');
  }
  if (!args.walletProvider.signSolanaMessage) {
    throw new Error(`wallet-provider ${args.walletProvider.id} does not implement signSolanaMessage`);
  }
  const sigB58 = await args.walletProvider.signSolanaMessage({ message: parsed.message });
  const sig = base58decode(sigB58);
  if (sig.length !== 64) {
    throw new Error(`signature expected 64 bytes, got ${sig.length}`);
  }
  // Replace slot 0 (fee payer / user) with our signature. Jupiter
  // always puts the user at slot 0.
  const sigs = [sig, ...parsed.signatures.slice(1)];
  const signed = reassembleTransaction(sigs, parsed.message);
  const signedB64 = bytesToBase64(signed);

  const rpcRes = await rpcCall<string>(args.rpcUrl, 'sendTransaction', [
    signedB64,
    {
      encoding: 'base64',
      skipPreflight: args.skipPreflight ?? false,
      maxRetries: args.maxRetries ?? 3,
    },
  ]);
  return rpcRes;
}

// ─── Confirmation polling ─────────────────────────────────────────

export interface TrackSolanaArgs {
  rpcUrl: string;
  signature: string;
  pollIntervalMs?: number;
  timeoutMs?: number;
  commitment?: SolanaCommitment;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export type SolanaOutcome =
  | { kind: 'confirmed'; slot: number; commitment: SolanaCommitment }
  | { kind: 'reverted'; err: string }
  | { kind: 'timeout'; elapsedMs: number };

interface SignatureStatus {
  slot: number;
  confirmations: number | null;
  err: unknown;
  confirmationStatus: SolanaCommitment | null;
}

export async function trackSolanaTransaction(args: TrackSolanaArgs): Promise<SolanaOutcome> {
  const pollIntervalMs = args.pollIntervalMs ?? 1_000;
  const timeoutMs = args.timeoutMs ?? 60_000;
  const target = args.commitment ?? 'confirmed';
  const now = args.now ?? (() => Date.now());
  const sleep = args.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const startedAt = now();

  while (true) {
    const elapsed = now() - startedAt;
    if (elapsed >= timeoutMs) return { kind: 'timeout', elapsedMs: elapsed };
    const statuses = await rpcCall<{ value: Array<SignatureStatus | null> }>(args.rpcUrl, 'getSignatureStatuses', [
      [args.signature],
      { searchTransactionHistory: false },
    ]);
    const s = statuses.value[0];
    if (s) {
      if (s.err) {
        return { kind: 'reverted', err: JSON.stringify(s.err).slice(0, 200) };
      }
      if (s.confirmationStatus && rankCommitment(s.confirmationStatus) >= rankCommitment(target)) {
        return { kind: 'confirmed', slot: s.slot, commitment: s.confirmationStatus };
      }
    }
    await sleep(pollIntervalMs);
  }
}

function rankCommitment(c: SolanaCommitment): number {
  switch (c) {
    case 'processed': return 0;
    case 'confirmed': return 1;
    case 'finalized': return 2;
  }
}

// ─── JSON-RPC helper ─────────────────────────────────────────────

async function rpcCall<T>(rpcUrl: string, method: string, params: unknown[]): Promise<T> {
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`rpc ${method} ${res.status}: ${text.slice(0, 200)}`);
  }
  const body = (await res.json()) as { result?: T; error?: { code: number; message: string } };
  if (body.error) {
    throw new Error(`rpc ${method}: ${body.error.message}`);
  }
  if (body.result === undefined) {
    throw new Error(`rpc ${method}: no result`);
  }
  return body.result;
}

// ─── base64 ──────────────────────────────────────────────────────

function base64ToBytes(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, 'base64'));
}
function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}
