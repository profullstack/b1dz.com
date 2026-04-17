/**
 * Uniswap V3 multi-hop path encoding + QuoterV2 `quoteExactInput` wrapper.
 *
 * Counterpart to uniswap-v3.ts (single-pool `quoteExactInputSingle`). Used
 * by the triangular-arb engine to price cyclic routes like
 * USDC → WETH → AERO → USDC in one RPC call.
 *
 * Path encoding (per Uniswap V3 docs §"Multihop Swaps"):
 *   bytes = tokenIn ++ fee(uint24) ++ mid ++ fee ++ ... ++ tokenOut
 *   where each address is 20 bytes and each fee is 3 bytes.
 *
 * A 3-hop triangle ends up as 3 tokens + 2 fees = 20 + 3 + 20 + 3 + 20 = 66 bytes.
 * A 4-token cycle (= 3 hops where first and last are the same token) is the
 * same length: the path is the token sequence, not the graph cycle.
 */

import { parseAbi, encodePacked, type Address, type Hex } from 'viem';

/** QuoterV2 ABI slice for `quoteExactInput(bytes path, uint256 amountIn)`.
 *  Returns (amountOut, sqrtPriceX96AfterList, initializedTicksCrossedList,
 *  gasEstimate). QuoterV2 is a view-like function that reverts on failure —
 *  it's intended to be called via eth_call / simulateContract. */
export const QUOTER_V2_MULTIHOP_ABI = parseAbi([
  'function quoteExactInput(bytes path, uint256 amountIn) external returns (uint256 amountOut, uint160[] sqrtPriceX96AfterList, uint32[] initializedTicksCrossedList, uint256 gasEstimate)',
]);

/** One hop of a multi-hop path. `tokenIn` of hop N+1 must equal `tokenOut`
 *  of hop N — the engine enforces this before calling `encodePath`. */
export interface MultihopHop {
  tokenIn: Address;
  tokenOut: Address;
  /** Uniswap V3 fee tier: 100 / 500 / 3000 / 10000. */
  fee: number;
}

const VALID_FEE_TIERS = [100, 500, 3000, 10000] as const;

/** Gas budget for a 3-hop `exactInput` on Base — empirical reference
 *  ~350-420k, 450k absorbs transient pool storage costs. Callers that
 *  know hop count can scale: base + ~100k per hop above 1. */
export const UNISWAP_V3_MULTIHOP_GAS_LIMIT = 450_000n;

/** Encode a multi-hop path into the SwapRouter02 / QuoterV2 path format.
 *
 *  Throws on:
 *    - empty hops
 *    - invalid fee tier
 *    - tokenOut[i] != tokenIn[i+1] (non-contiguous hops)
 *
 *  Returns a 0x-prefixed hex string. Length = 20 + (20 + 3) * hops.length - 20
 *  ... wait, cleaner: length = 20 + hops.length * (3 + 20) - 20
 *  = 20 * (hops.length + 1) + 3 * hops.length when expressed per-token.
 *  Simpler: see test vectors — 66 bytes for 3 hops.
 */
export function encodePath(hops: MultihopHop[]): Hex {
  if (hops.length === 0) throw new Error('encodePath: hops must be non-empty');

  for (let i = 0; i < hops.length; i++) {
    const h = hops[i];
    if (!VALID_FEE_TIERS.includes(h.fee as typeof VALID_FEE_TIERS[number])) {
      throw new Error(`encodePath: invalid fee tier ${h.fee} at hop ${i}`);
    }
    if (i > 0) {
      const prev = hops[i - 1];
      if (prev.tokenOut.toLowerCase() !== h.tokenIn.toLowerCase()) {
        throw new Error(
          `encodePath: hop ${i} tokenIn ${h.tokenIn} does not match hop ${i - 1} tokenOut ${prev.tokenOut}`,
        );
      }
    }
  }

  // Build the type/value arrays for encodePacked: [addr, uint24, addr, uint24, ..., addr]
  const types: string[] = ['address'];
  const values: Array<Address | number> = [hops[0].tokenIn];
  for (const h of hops) {
    types.push('uint24', 'address');
    values.push(h.fee, h.tokenOut);
  }
  // viem's encodePacked is strictly typed but the dynamic builder above
  // is sound at runtime. Cast to the expected tuple shape.
  return encodePacked(
    types as readonly ('address' | 'uint24')[],
    values as readonly (Address | number)[],
  );
}

/** Result of a multi-hop quote. `amountOut` is in tokenOut base units;
 *  `gasEstimate` is the quoter's own advisory number (callers typically
 *  override with a conservative fixed budget when pricing profitability). */
export interface MultihopQuoteResult {
  amountOut: bigint;
  gasEstimate: bigint;
}

/** Call QuoterV2.quoteExactInput via `simulateContract`. Returns null if
 *  the quoter reverts — treating "no liquidity / tick crossed revert" as
 *  "no quote" rather than throwing, matching the single-pool adapter's
 *  fee-tier fan-out behavior.
 *
 *  The client is typed as `unknown` to sidestep viem's chain-generic
 *  inference at the boundary; call-site only needs
 *  `simulateContract()` and the `.result` tuple. */
export async function quoteExactInputMultihop(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: any,
  quoter: Address,
  path: Hex,
  amountIn: bigint,
): Promise<MultihopQuoteResult | null> {
  if (amountIn <= 0n) return null;
  try {
    const res = await client.simulateContract({
      address: quoter,
      abi: QUOTER_V2_MULTIHOP_ABI,
      functionName: 'quoteExactInput',
      args: [path, amountIn],
    });
    const [amountOut, , , gasEstimate] = res.result as [bigint, bigint[], number[], bigint];
    if (amountOut <= 0n) return null;
    return { amountOut, gasEstimate };
  } catch {
    return null;
  }
}
