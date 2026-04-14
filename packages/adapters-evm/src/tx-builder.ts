/**
 * EVM transaction builder (PRD §29 Phase 3).
 *
 * Assembles EIP-1559 transaction requests, hashes them for signing by
 * a `WalletProvider.signDigest()` implementation, and reassembles the
 * signed payload for broadcast.
 *
 * Why split signing from serialization:
 *   - the wallet-provider abstraction only exposes `signDigest` —
 *     direct-EVM and CoinPay both produce a secp256k1 signature over
 *     an arbitrary digest. Packaging that into an RLP-encoded signed
 *     EIP-1559 tx (type 2) happens here.
 *   - tests can exercise the full build → sign → reassemble flow
 *     without a live RPC by mocking just the wallet-provider.
 *
 * The `nonce` must be supplied by the caller — this module does not
 * talk to an RPC. That keeps the builder a pure function and lets the
 * wallet service layer own nonce tracking.
 */

import {
  keccak256,
  serializeTransaction,
  parseSignature,
  type Address,
  type Hex,
  type TransactionSerializableEIP1559,
} from 'viem';
import type { EvmChain } from './tokens.js';
import { EVM_CHAIN_IDS } from './tokens.js';
import type { FeeData } from './gas.js';

export interface UnsignedTx {
  chain: EvmChain;
  chainId: number;
  from: Address;
  to: Address;
  data: Hex;
  value: bigint;
  gasLimit: bigint;
  nonce: number;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

export interface BuildTxArgs {
  chain: EvmChain;
  from: Address;
  to: Address;
  data: Hex;
  value?: bigint;
  gasLimit: bigint;
  nonce: number;
  feeData: FeeData;
}

export function buildUnsignedTx(args: BuildTxArgs): UnsignedTx {
  if (args.feeData.chain !== args.chain) {
    throw new Error(`fee data is for ${args.feeData.chain} but tx is for ${args.chain}`);
  }
  const chainId = EVM_CHAIN_IDS[args.chain];
  if (chainId === undefined) throw new Error(`no chainId for ${args.chain}`);
  if (args.gasLimit <= 0n) throw new Error('gasLimit must be > 0');
  if (args.nonce < 0 || !Number.isInteger(args.nonce)) throw new Error('nonce must be a non-negative integer');
  return {
    chain: args.chain,
    chainId,
    from: args.from,
    to: args.to,
    data: args.data,
    value: args.value ?? 0n,
    gasLimit: args.gasLimit,
    nonce: args.nonce,
    maxFeePerGas: args.feeData.maxFeePerGas,
    maxPriorityFeePerGas: args.feeData.maxPriorityFeePerGas,
  };
}

/** Viem-compatible EIP-1559 serializable shape. */
export function toSerializable(tx: UnsignedTx): TransactionSerializableEIP1559 {
  return {
    type: 'eip1559',
    chainId: tx.chainId,
    to: tx.to,
    data: tx.data,
    value: tx.value,
    gas: tx.gasLimit,
    nonce: tx.nonce,
    maxFeePerGas: tx.maxFeePerGas,
    maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
  };
}

/**
 * Keccak256 of the unsigned RLP-encoded EIP-1559 payload. Hand this
 * to `WalletProvider.signDigest({ chain, digestHex })`.
 */
export function digestForSigning(tx: UnsignedTx): Hex {
  const serialized = serializeTransaction(toSerializable(tx));
  return keccak256(serialized);
}

/**
 * Assemble the final broadcast-ready signed tx. `signatureHex` is the
 * 65-byte secp256k1 signature (`r` || `s` || `v`) produced by the
 * wallet provider over `digestForSigning(tx)`.
 */
export function assembleSignedTx(tx: UnsignedTx, signatureHex: Hex): Hex {
  const sig = parseSignature(signatureHex);
  return serializeTransaction(toSerializable(tx), sig);
}
