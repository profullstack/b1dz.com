/**
 * Uniswap V3 direct-quote adapter (PRD §14.5 ABI workflow reference).
 *
 * Calls the Uniswap Quoter V2 contract directly via an EVM RPC. Unlike
 * 0x/1inch (aggregators that stitch routes across many protocols), this
 * queries a single pool at a specific fee tier on Uniswap V3 only —
 * useful for direct-venue vs aggregator edge testing per PRD §10.4.
 *
 * ABI scope is deliberately narrow: just QuoterV2.quoteExactInputSingle
 * and the immutable SwapRouter02 address (for when execution lands in
 * a later phase). No factory / pool / position manager ABIs in MVP.
 */

import { createPublicClient, http, parseAbi, type Address, type Hex } from 'viem';
import { base, mainnet, arbitrum, optimism, polygon, avalanche } from 'viem/chains';
import type {
  NormalizedQuote,
  QuoteRequest,
  VenueAdapter,
  AdapterHealth,
} from '@b1dz/venue-types';
import {
  tokenFor,
  toBaseUnits,
  fromBaseUnits,
  isEvmChain,
  type EvmChain,
} from './tokens.js';

/**
 * Uniswap V3 fee tiers. 500 = 0.05% (stable-stable), 3000 = 0.3%
 * (standard), 10000 = 1% (exotic). 100 = 0.01% exists but is rarely
 * used.
 */
export type UniswapV3FeeTier = 100 | 500 | 3000 | 10000;
export const UNISWAP_V3_FEE_TIERS: readonly UniswapV3FeeTier[] = [100, 500, 3000, 10000];

const QUOTER_V2_ABI = parseAbi([
  'struct QuoteExactInputSingleParams { address tokenIn; address tokenOut; uint256 amountIn; uint24 fee; uint160 sqrtPriceLimitX96; }',
  'function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) public returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
]);

interface ChainConfig {
  quoter: Address;
  router: Address;
  rpcEnvVar: string;
  /** viem chain definition for the public client. */
  viemChain: ReturnType<typeof defineChain>;
}

function defineChain(name: string) {
  switch (name) {
    case 'ethereum': return mainnet;
    case 'base': return base;
    case 'arbitrum': return arbitrum;
    case 'optimism': return optimism;
    case 'polygon': return polygon;
    case 'avalanche': return avalanche;
    default: throw new Error(`unsupported chain ${name}`);
  }
}

/**
 * Uniswap V3 QuoterV2 + SwapRouter02 contract addresses per chain.
 * Published by Uniswap Labs and stable across deployments. If a chain
 * isn't listed here, the adapter won't init.
 */
const CHAIN_CONFIG: Partial<Record<EvmChain, ChainConfig>> = {
  ethereum: {
    quoter: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
    router: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',
    rpcEnvVar: 'ETHEREUM_RPC_URL',
    viemChain: mainnet,
  },
  base: {
    quoter: '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a',
    router: '0x2626664c2603336E57B271c5C0b26F421741e481',
    rpcEnvVar: 'BASE_RPC_URL',
    viemChain: base,
  },
  arbitrum: {
    quoter: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
    router: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',
    rpcEnvVar: 'ARBITRUM_RPC_URL',
    viemChain: arbitrum,
  },
  optimism: {
    quoter: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
    router: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',
    rpcEnvVar: 'OPTIMISM_RPC_URL',
    viemChain: optimism,
  },
  polygon: {
    quoter: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
    router: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',
    rpcEnvVar: 'POLYGON_RPC_URL',
    viemChain: polygon,
  },
};

export interface UniswapV3AdapterOptions {
  chain: EvmChain;
  /** Custom RPC URL. If omitted, reads from `<CHAIN>_RPC_URL` env. */
  rpcUrl?: string;
  /** Which fee tiers to quote. Default all four. The adapter picks the
   *  best amount out across the enumerated tiers. */
  feeTiers?: readonly UniswapV3FeeTier[];
  /** viem client injection for tests. Typed as unknown because
   *  PublicClient's chain generic surface conflicts across chains and
   *  we don't need the inferred type precision at the call sites. */
  client?: unknown;
}

interface TierQuote {
  fee: UniswapV3FeeTier;
  amountOut: bigint;
  gasEstimate: bigint;
}

export class UniswapV3Adapter implements VenueAdapter {
  readonly venue = 'uniswap-v3';
  readonly venueType = 'dex' as const;
  readonly chain: EvmChain;
  private readonly config: ChainConfig;
  /** See client? option: we interact via `any` because viem's chain
   *  generics make a precise type unwieldy and we don't benefit from
   *  the inference at any call site. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly client: any;
  private readonly feeTiers: readonly UniswapV3FeeTier[];

  constructor(opts: UniswapV3AdapterOptions) {
    const cfg = CHAIN_CONFIG[opts.chain];
    if (!cfg) throw new Error(`Uniswap V3 not configured for chain "${opts.chain}"`);
    this.chain = opts.chain;
    this.config = cfg;
    this.feeTiers = opts.feeTiers ?? UNISWAP_V3_FEE_TIERS;
    this.client = opts.client ?? createPublicClient({
      chain: cfg.viemChain,
      transport: http(opts.rpcUrl ?? process.env[cfg.rpcEnvVar]),
    });
  }

  async health(): Promise<AdapterHealth> {
    try {
      const started = Date.now();
      const blockNumber: bigint = await this.client.getBlockNumber();
      if (blockNumber === 0n) return { ok: false, reason: 'block 0' };
      return { ok: true, latencyMs: Date.now() - started };
    } catch (e) {
      return { ok: false, reason: (e as Error).message.slice(0, 200) };
    }
  }

  async supports(req: QuoteRequest): Promise<boolean> {
    if (req.chain && !isEvmChain(req.chain)) return false;
    if (req.chain && req.chain !== this.chain) return false;
    const [base_, quote] = req.pair.split('-');
    return !!(tokenFor(this.chain, base_) && tokenFor(this.chain, quote));
  }

  async quote(req: QuoteRequest): Promise<NormalizedQuote | null> {
    if (!(await this.supports(req))) return null;
    const [baseSymbol, quoteSymbol] = req.pair.split('-');
    const baseToken = tokenFor(this.chain, baseSymbol)!;
    const quoteToken = tokenFor(this.chain, quoteSymbol)!;
    const tokenIn = req.side === 'buy' ? quoteToken : baseToken;
    const tokenOut = req.side === 'buy' ? baseToken : quoteToken;
    const amountIn = toBaseUnits(req.amountIn, tokenIn.decimals);

    const started = Date.now();
    const tierResults = await this.quoteAllFeeTiers(tokenIn.address, tokenOut.address, BigInt(amountIn));
    if (tierResults.length === 0) return null;

    // Pick the tier with the best (largest) amountOut.
    const best = tierResults.reduce((a, b) => (a.amountOut > b.amountOut ? a : b));

    const amountInDecimal = fromBaseUnits(amountIn, tokenIn.decimals);
    const amountOutDecimal = fromBaseUnits(best.amountOut.toString(), tokenOut.decimals);
    const unitPrice = Number.parseFloat(amountOutDecimal) / Number.parseFloat(amountInDecimal);

    // Gas USD estimate — for MVP reuse the same rough native price we
    // use in the 0x/1inch adapters until the shared gas oracle lands.
    const nativeUsd = this.nativeUsdPrice();
    const gasWei = best.gasEstimate * 1_000_000_000n; // assume 1 gwei
    const gasUsd = (Number(gasWei) / 1e18) * nativeUsd;

    const feePctString = (best.fee / 10_000).toFixed(2) + '%';

    return {
      venue: 'uniswap-v3',
      venueType: 'dex',
      chain: this.chain,
      dexProtocol: 'uniswap-v3',
      pair: req.pair,
      baseAsset: baseSymbol,
      quoteAsset: quoteSymbol,
      amountIn: amountInDecimal,
      amountOut: amountOutDecimal,
      amountInUsd: null,
      amountOutUsd: null,
      side: req.side,
      estimatedUnitPrice: unitPrice.toString(),
      feeUsd: 0, // pool fee is baked into amountOut; no additional protocol fee
      gasUsd,
      slippageBps: req.maxSlippageBps ?? 50,
      priceImpactBps: null,
      routeHops: 1,
      routeSummary: [`uni-v3 ${feePctString} pool`],
      quoteTimestamp: started,
      expiresAt: null,
      latencyMs: Date.now() - started,
      allowanceRequired: tokenIn.address.toLowerCase() !== '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
      approvalToken: tokenIn.address,
      tokenLifecycle: null,
      raw: { fee: best.fee, amountOut: best.amountOut.toString(), gasEstimate: best.gasEstimate.toString() },
    };
  }

  /**
   * Fan out quoteExactInputSingle across every enabled fee tier.
   * Tiers that don't have liquidity revert — we treat reverts as "no
   * quote" rather than errors so the caller can still see results
   * from pools that do exist.
   */
  private async quoteAllFeeTiers(
    tokenIn: string,
    tokenOut: string,
    amountIn: bigint,
  ): Promise<TierQuote[]> {
    const results: TierQuote[] = [];
    await Promise.all(this.feeTiers.map(async (fee) => {
      try {
        const res = await this.client.simulateContract({
          address: this.config.quoter,
          abi: QUOTER_V2_ABI,
          functionName: 'quoteExactInputSingle',
          args: [{
            tokenIn: tokenIn as Address,
            tokenOut: tokenOut as Address,
            amountIn,
            fee,
            sqrtPriceLimitX96: 0n,
          }],
        });
        const [amountOut, , , gasEstimate] = res.result as [bigint, bigint, number, bigint];
        if (amountOut > 0n) {
          results.push({ fee, amountOut, gasEstimate });
        }
      } catch {
        // tier has no liquidity for this pair — skip silently
      }
    }));
    return results;
  }

  routerAddress(): Hex {
    return this.config.router as Hex;
  }

  quoterAddress(): Hex {
    return this.config.quoter as Hex;
  }

  private nativeUsdPrice(): number {
    const prices: Record<EvmChain, number> = {
      ethereum: 2500,
      base: 2500,
      avalanche: 30,
      arbitrum: 2500,
      optimism: 2500,
      polygon: 0.5,
    };
    return prices[this.chain];
  }
}
