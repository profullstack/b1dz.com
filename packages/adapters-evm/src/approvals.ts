/**
 * ERC20 approval manager (PRD §15.2).
 *
 * Every EVM DEX swap that spends an ERC20 needs the router's allowance
 * set first. This module keeps the allowance check + approval-tx
 * construction + cost-vs-edge gate in one place so every adapter (0x,
 * 1inch, Uniswap V3, future direct venues) shares the same policy.
 *
 * Modes:
 *   - `exact` — approve the precise amount we're about to spend.
 *     Safer against compromised routers but costs gas for every new
 *     size. Default for live mode.
 *   - `unlimited` — approve uint256 max, skip future approvals for
 *     this (token, spender) pair. Cheaper amortized cost but an
 *     exploit of the router drains the wallet. Only enable per-token
 *     via explicit config.
 *
 * Native-asset swaps (e.g. ETH → USDC through a router) never need an
 * approval — the native value is sent with `msg.value`. Callers must
 * skip this module entirely for those paths.
 */

import {
  parseAbi,
  encodeFunctionData,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';

export const ERC20_APPROVAL_ABI = parseAbi([
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
]);

/** Typical approve() gas limit. ERC20 approvals are ~46k; we round up
 *  to 60k to absorb storage-slot cold/warm variance. Tokens with
 *  bespoke approve hooks (USDT pre-re-enable dance) will blow past
 *  this — those are flagged at quote time. */
export const APPROVAL_GAS_LIMIT = 60_000n;

export const UINT256_MAX = (1n << 256n) - 1n;

export type ApprovalMode = 'exact' | 'unlimited';

export interface AllowanceReadArgs {
  client: Pick<PublicClient, 'readContract'>;
  token: Address;
  owner: Address;
  spender: Address;
}

export async function readAllowance(args: AllowanceReadArgs): Promise<bigint> {
  const value = await args.client.readContract({
    address: args.token,
    abi: ERC20_APPROVAL_ABI,
    functionName: 'allowance',
    args: [args.owner, args.spender],
  });
  return value as bigint;
}

export interface ApprovalNeed {
  /** True when the current allowance is insufficient for `required`. */
  needed: boolean;
  /** Current on-chain allowance at check time. */
  current: bigint;
  /** Amount the swap will actually spend. */
  required: bigint;
  /** Amount we'd set if the caller asks us to construct the approval tx. */
  approvalAmount: bigint;
  token: Address;
  spender: Address;
  mode: ApprovalMode;
}

export interface CheckApprovalArgs extends AllowanceReadArgs {
  required: bigint;
  mode: ApprovalMode;
}

export async function checkApproval(args: CheckApprovalArgs): Promise<ApprovalNeed> {
  const current = await readAllowance(args);
  const approvalAmount = args.mode === 'unlimited' ? UINT256_MAX : args.required;
  return {
    needed: current < args.required,
    current,
    required: args.required,
    approvalAmount,
    token: args.token,
    spender: args.spender,
    mode: args.mode,
  };
}

export interface ApprovalTx {
  to: Address;
  data: Hex;
  /** Native value is always 0 for ERC20.approve(). */
  value: 0n;
  /** Suggested gas limit; execution caller should still estimate. */
  gasLimit: bigint;
}

export function buildApprovalTx(need: ApprovalNeed): ApprovalTx {
  const data = encodeFunctionData({
    abi: ERC20_APPROVAL_ABI,
    functionName: 'approve',
    args: [need.spender, need.approvalAmount],
  });
  return { to: need.token, data, value: 0n, gasLimit: APPROVAL_GAS_LIMIT };
}

/**
 * PRD §15.2: "reject routes that require approval when approval cost
 * kills edge". Returns null if the cost is acceptable, or a blocker
 * string matching the engine's other gate messages.
 */
export function approvalCostKillsEdge(
  approvalUsd: number,
  edgeUsd: number,
  maxRatio: number = 0.5,
): string | null {
  if (approvalUsd <= 0) return null;
  if (edgeUsd <= 0) return 'no edge to amortize approval cost';
  if (approvalUsd / edgeUsd > maxRatio) {
    return `approval cost $${approvalUsd.toFixed(4)} > ${(maxRatio * 100).toFixed(0)}% of edge $${edgeUsd.toFixed(4)}`;
  }
  return null;
}

/**
 * USDT-style "must zero before re-approve" pattern: some tokens revert
 * on `approve(spender, nonZero)` when the current allowance is already
 * non-zero. Callers that know they're about to hit such a token should
 * wrap their flow in `safeApproveCalls()` which emits two calldatas:
 * first to zero, then to set the target amount.
 */
export function safeApproveCalls(need: ApprovalNeed): readonly ApprovalTx[] {
  if (!need.needed) return [];
  if (need.current === 0n) return [buildApprovalTx(need)];
  const zero: ApprovalNeed = { ...need, approvalAmount: 0n };
  return [buildApprovalTx(zero), buildApprovalTx(need)];
}
