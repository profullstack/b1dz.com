/**
 * Uniswap V3 SwapRouter02 calldata encoders (PRD §29 Phase 3).
 *
 * Pure functions — no RPC, no wallet, no I/O. Callers (executors) hand
 * in already-normalized token addresses + amounts and get back `{ to,
 * data, value, gasLimit }` ready for `WalletService.execute()`.
 *
 * Scope is deliberately narrow: only the single-pool path
 * (`exactInputSingle`). Multi-hop routing lives in the aggregator
 * adapters (0x / 1inch) — direct-venue execution only needs the
 * shortest path.
 *
 * The SwapRouter02 address is chain-fixed by Uniswap; the Uniswap V3
 * adapter's `routerAddress()` returns the same constant.
 */

import {
  encodeFunctionData,
  parseAbi,
  type Address,
  type Hex,
} from 'viem';

export const SWAP_ROUTER_02_ABI = parseAbi([
  'struct ExactInputSingleParams { address tokenIn; address tokenOut; uint24 fee; address recipient; uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96; }',
  'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) external payable returns (uint256 amountOut)',
]);

export interface ExactInputSingleArgs {
  router: Address;
  tokenIn: Address;
  tokenOut: Address;
  /** Uniswap V3 fee tier — 100 / 500 / 3000 / 10000. */
  fee: number;
  recipient: Address;
  /** Spend amount in tokenIn base units. */
  amountIn: bigint;
  /** Minimum acceptable output. Derive from quote + slippageBps. */
  amountOutMinimum: bigint;
  /** Native value to send with the call (only > 0 when tokenIn is the
   *  chain's wrapped native and the caller wants the router to wrap
   *  msg.value on their behalf). */
  value?: bigint;
  /** Gas limit hint the WalletService should use. Caller can bump
   *  this before submission based on its own estimate. */
  gasLimit?: bigint;
}

export interface ExactInputSingleCall {
  to: Address;
  data: Hex;
  value: bigint;
  gasLimit: bigint;
}

/** Default gas limit for a single-pool swap. Empirical single-hop
 *  uni-v3 swaps are ~130-180k on Base; 250k absorbs transient pool
 *  storage costs. */
export const UNISWAP_V3_SWAP_GAS_LIMIT = 250_000n;

export function encodeExactInputSingle(args: ExactInputSingleArgs): ExactInputSingleCall {
  if (args.amountIn <= 0n) throw new Error('amountIn must be > 0');
  if (args.amountOutMinimum < 0n) throw new Error('amountOutMinimum must be >= 0');
  if (![100, 500, 3000, 10000].includes(args.fee)) {
    throw new Error(`invalid uniswap-v3 fee tier ${args.fee}`);
  }
  const data = encodeFunctionData({
    abi: SWAP_ROUTER_02_ABI,
    functionName: 'exactInputSingle',
    args: [{
      tokenIn: args.tokenIn,
      tokenOut: args.tokenOut,
      fee: args.fee,
      recipient: args.recipient,
      amountIn: args.amountIn,
      amountOutMinimum: args.amountOutMinimum,
      sqrtPriceLimitX96: 0n,
    }],
  });
  return {
    to: args.router,
    data,
    value: args.value ?? 0n,
    gasLimit: args.gasLimit ?? UNISWAP_V3_SWAP_GAS_LIMIT,
  };
}

/** Derive `amountOutMinimum` from a quoted output + slippage tolerance.
 *  slippageBps=50 means "accept up to 0.5% worse than quoted". */
export function minOutFromSlippage(quotedAmountOut: bigint, slippageBps: number): bigint {
  if (quotedAmountOut <= 0n) return 0n;
  const bps = Math.max(0, Math.floor(slippageBps));
  // Integer math: floor(quotedAmountOut * (10000 - bps) / 10000)
  const retained = 10_000n - BigInt(bps);
  return (quotedAmountOut * retained) / 10_000n;
}
