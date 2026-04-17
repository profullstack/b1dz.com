/**
 * Triangular route pricer.
 *
 * Given a Triangle + venue config + amountIn, call the Uniswap V3
 * QuoterV2 multi-hop endpoint once per triangle and compute an
 * expectedNetUsd that accounts for pool fees (baked into `amountOut`)
 * and gas cost (a single atomic tx budget — not per-hop).
 *
 * No slippage is modeled separately here; `buildTriangularOpportunity`
 * subtracts a flat bps buffer downstream. The quoter's amountOut already
 * reflects live pool state + pool fees + price impact for the chosen
 * input size.
 */

import type { Address, Hex } from 'viem';
import {
  encodePath,
  quoteExactInputMultihop,
  UNISWAP_V3_MULTIHOP_GAS_LIMIT,
  estimateTxCostUsd,
  toBaseUnits,
  fromBaseUnits,
  tokenFor,
  type EvmChain,
  type GasOracle,
  type MultihopHop,
} from '@b1dz/adapters-evm';
import type { Triangle } from './enumerator.js';

export interface PricedTriangle {
  triangle: Triangle;
  /** Anchor-denominated amounts — for a USDC-anchored route, USDC in/out. */
  amountInDecimal: string;
  amountOutDecimal: string;
  amountInUsd: number;
  amountOutUsd: number;
  grossEdgeUsd: number;
  gasUsd: number;
  expectedNetUsd: number;
  /** Encoded SwapRouter02 path bytes — ready for a triangular executor. */
  path: Hex;
  hops: Array<{ tokenIn: string; tokenOut: string; fee: number }>;
}

export interface PriceTriangleArgs {
  triangle: Triangle;
  chain: EvmChain;
  /** viem PublicClient. Typed as unknown at the boundary (see uniswap-v3.ts). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: any;
  quoter: Address;
  /** Anchor-denominated input size, e.g. 100 USDC. */
  amountInDecimal: string;
  /** Uniswap V3 fee tier for every hop (MVP: single tier). */
  feeTier: number;
  gasOracle: GasOracle;
  /** Native-token USD price resolver (used for gas → USD). */
  nativeUsd: () => Promise<number> | number;
  /** Override the multi-hop gas-limit budget. Default 450k. */
  gasLimit?: bigint;
  /** Treat the anchor as 1:1 USD (fine for USDC/USDT/DAI). Default true. */
  anchorIsStable?: boolean;
}

/** Price a single triangle. Returns null if any hop lacks liquidity, the
 *  quoter reverts, or token addresses can't be resolved. */
export async function priceTriangle(args: PriceTriangleArgs): Promise<PricedTriangle | null> {
  const { triangle, chain, client, quoter, amountInDecimal, feeTier, gasOracle } = args;
  const anchorStable = args.anchorIsStable ?? true;

  const anchorTok = tokenFor(chain, triangle.anchor);
  const midATok = tokenFor(chain, triangle.midA);
  const midBTok = tokenFor(chain, triangle.midB);
  if (!anchorTok || !midATok || !midBTok) return null;

  const hops: MultihopHop[] = [
    { tokenIn: anchorTok.address as Address, tokenOut: midATok.address as Address, fee: feeTier },
    { tokenIn: midATok.address as Address, tokenOut: midBTok.address as Address, fee: feeTier },
    { tokenIn: midBTok.address as Address, tokenOut: anchorTok.address as Address, fee: feeTier },
  ];
  const path = encodePath(hops);

  const amountInBase = BigInt(toBaseUnits(amountInDecimal, anchorTok.decimals));
  const quoted = await quoteExactInputMultihop(client, quoter, path, amountInBase);
  if (!quoted) return null;

  const amountOutDecimal = fromBaseUnits(quoted.amountOut.toString(), anchorTok.decimals);

  const fee = await gasOracle.getFeeData(chain);
  const nativeUsd = await args.nativeUsd();
  const gasLimit = args.gasLimit ?? UNISWAP_V3_MULTIHOP_GAS_LIMIT;
  const gasUsd = estimateTxCostUsd(fee, gasLimit, nativeUsd, { bufferBps: 2000 });

  const amountInNum = Number.parseFloat(amountInDecimal);
  const amountOutNum = Number.parseFloat(amountOutDecimal);
  // For a stablecoin anchor, the "USD" value is the decimal amount itself.
  // For non-stable anchors, the caller should pre-convert amountIn to USD
  // and treat amountOut via a pricing service — out of scope for MVP.
  const amountInUsd = anchorStable ? amountInNum : amountInNum;
  const amountOutUsd = anchorStable ? amountOutNum : amountOutNum;
  const grossEdgeUsd = amountOutUsd - amountInUsd;
  const expectedNetUsd = grossEdgeUsd - gasUsd;

  return {
    triangle,
    amountInDecimal,
    amountOutDecimal,
    amountInUsd,
    amountOutUsd,
    grossEdgeUsd,
    gasUsd,
    expectedNetUsd,
    path,
    hops: hops.map((h, i) => ({
      tokenIn: i === 0 ? triangle.anchor : i === 1 ? triangle.midA : triangle.midB,
      tokenOut: i === 0 ? triangle.midA : i === 1 ? triangle.midB : triangle.anchor,
      fee: h.fee,
    })),
  };
}
