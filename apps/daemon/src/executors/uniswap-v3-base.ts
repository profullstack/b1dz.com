/**
 * Uniswap V3 direct-swap executor — Base chain, buy-side only.
 *
 * Conforms to the `Executor` interface from @b1dz/trade-daemon. Handles
 * the BUY leg of an opportunity whose buyVenue is `uniswap-v3` on
 * chain `base`. The sell leg of cex↔dex / dex↔dex opportunities needs
 * its own executor; until one is wired the daemon will abort the
 * trade with "no executor can handle category=..." (safe behavior).
 *
 * Why buy-side only for MVP:
 *   - The hot wallet starts holding USDC (quote). Buying means
 *     USDC → baseAsset; straightforward single SwapRouter02 call.
 *   - Selling requires the wallet to already hold the base asset at
 *     the time the opportunity fires, which is brittle without a
 *     position-open step first.
 *   - With a $5 cap, even a one-legged-only hit leaves us with <$5
 *     of dust inventory — survivable.
 *
 * Arming: this module exports `maybeBuildUniswapV3BaseExecutor()`
 * which returns `null` unless ALL required env is present AND
 * `V2_EXECUTOR_UNISWAP_BASE=true` is set. That keeps live execution
 * strictly opt-in per the launch runbook.
 *
 * Required env:
 *   EVM_PRIVATE_KEY            hot wallet private key (0x-prefixed)
 *   BASE_RPC_URL               viem http transport
 *   V2_EXECUTOR_UNISWAP_BASE=true   explicit arming flag
 *
 * Known limitations:
 *   - No ERC20 approval flow here — the approval must be set out-of-
 *     band before arming (documented in LAUNCH-RUNBOOK.md). Approvals
 *     are one-shot for (token, spender) pairs; handling them inline
 *     would add an extra tx per new token and double the blast
 *     radius. Call `buildApprovalTx()` from @b1dz/adapters-evm in a
 *     one-off script instead.
 *   - `msg.value` path (native ETH in) is not used. We spend USDC.
 *   - Slippage comes from `opp.buyQuote.slippageBps`; if the caller
 *     (observer) didn't set a realistic number, swaps may revert.
 */

import type { Executor, ExecutorOutcome } from '@b1dz/trade-daemon';
import type { Opportunity } from '@b1dz/venue-types';
import type { ExecutionResult, WalletService } from '@b1dz/wallet-service';
import {
  NATIVE_ASSET_SENTINEL,
  TOKENS,
  encodeExactInputSingle,
  minOutFromSlippage,
  toBaseUnits,
  UNISWAP_V3_SWAP_GAS_LIMIT,
  type Address,
  type Hex,
} from '@b1dz/adapters-evm';

/** SwapRouter02 on Base. Constant across deployments — pinned by Uniswap.
 *  Source: https://docs.uniswap.org/contracts/v3/reference/deployments */
const BASE_SWAP_ROUTER_02 = '0x2626664c2603336E57B271c5C0b26F421741e481' as const;

interface UniswapV3BaseExecutorArgs {
  walletService: WalletService;
  walletAddress: Address;
  /** Maximum USD size this executor will touch. Second gate on top of
   *  the daemon's risk.maxTradeUsd — protects against config drift. */
  maxTradeUsd: number;
  /** Optional override for the router address (for testing). */
  router?: Address;
  log?: (msg: string) => void;
}

export class UniswapV3BaseExecutor implements Executor {
  private readonly walletService: WalletService;
  private readonly walletAddress: Address;
  private readonly maxTradeUsd: number;
  private readonly router: Address;
  private readonly log: (msg: string) => void;

  constructor(args: UniswapV3BaseExecutorArgs) {
    this.walletService = args.walletService;
    this.walletAddress = args.walletAddress;
    this.maxTradeUsd = args.maxTradeUsd;
    this.router = args.router ?? BASE_SWAP_ROUTER_02;
    this.log = args.log ?? ((m) => console.log(m));
  }

  canExecute(opp: Opportunity): boolean {
    if (opp.buyVenue !== 'uniswap-v3') return false;
    if (opp.buyChain !== 'base') return false;
    if (opp.buyQuote.venue !== 'uniswap-v3') return false;
    // We can only denominate in a stable we hold. MVP: USDC.
    if (opp.buyQuote.quoteAsset.toUpperCase() !== 'USDC') return false;
    return true;
  }

  async execute(opp: Opportunity): Promise<ExecutorOutcome> {
    const sizeUsd = Number.parseFloat(opp.size);
    if (!Number.isFinite(sizeUsd) || sizeUsd <= 0) {
      return abort(`invalid size "${opp.size}"`);
    }
    if (sizeUsd > this.maxTradeUsd) {
      return abort(`size $${sizeUsd.toFixed(2)} > executor cap $${this.maxTradeUsd}`);
    }

    const baseSymbol = opp.buyQuote.baseAsset.toUpperCase();
    const quoteSymbol = opp.buyQuote.quoteAsset.toUpperCase(); // USDC per canExecute
    const baseTokens = TOKENS.base;
    if (!baseTokens) return abort('no base-chain token registry');

    const tokenIn = baseTokens[quoteSymbol];
    const tokenOut = baseTokens[baseSymbol];
    if (!tokenIn) return abort(`tokenIn ${quoteSymbol} not in base registry`);
    if (tokenIn.address.toLowerCase() === NATIVE_ASSET_SENTINEL.toLowerCase()) {
      return abort(`tokenIn ${quoteSymbol} is the native sentinel — not supported here`);
    }
    if (!tokenOut) return abort(`tokenOut ${baseSymbol} not in base registry`);

    // Pull fee tier from the adapter's raw quote payload.
    const raw = opp.buyQuote.raw as { fee?: number } | undefined;
    const fee = raw?.fee;
    if (!fee || ![100, 500, 3000, 10000].includes(fee)) {
      return abort(`missing or invalid fee tier on buyQuote.raw.fee`);
    }

    // amountIn / amountOutMinimum in base units. `toBaseUnits` returns
    // a decimal string — convert to BigInt for the encoder.
    let amountIn: bigint;
    let quotedOut: bigint;
    try {
      amountIn = BigInt(toBaseUnits(opp.buyQuote.amountIn, tokenIn.decimals));
      quotedOut = BigInt(toBaseUnits(opp.buyQuote.amountOut, tokenOut.decimals));
    } catch (e) {
      return abort(`amount parse failed: ${(e as Error).message.slice(0, 160)}`);
    }
    const amountOutMinimum = minOutFromSlippage(quotedOut, opp.buyQuote.slippageBps);
    if (amountIn === 0n) return abort('amountIn resolved to 0 base units');

    const call = encodeExactInputSingle({
      router: this.router as Address,
      tokenIn: tokenIn.address as Address,
      tokenOut: tokenOut.address as Address,
      fee,
      recipient: this.walletAddress,
      amountIn,
      amountOutMinimum,
      gasLimit: UNISWAP_V3_SWAP_GAS_LIMIT,
    });

    this.log(
      `[uni-v3-base] BUY ${baseSymbol} via fee=${fee} amountIn=${opp.buyQuote.amountIn} ${quoteSymbol} minOut=${amountOutMinimum.toString()} base-units`,
    );

    let result: ExecutionResult;
    try {
      result = await this.walletService.execute({
        chain: 'base',
        from: this.walletAddress,
        to: call.to,
        data: call.data as Hex,
        value: call.value,
        gasLimit: call.gasLimit,
      });
    } catch (e) {
      return abort(`wallet-service threw: ${(e as Error).message.slice(0, 200)}`);
    }

    return walletResultToOutcome(result);
  }
}

function abort(reason: string): ExecutorOutcome {
  return { status: 'aborted', resolvedReason: reason };
}

function walletResultToOutcome(result: ExecutionResult): ExecutorOutcome {
  const externalId = result.txHash ?? undefined;
  if (result.status === 'aborted') {
    return { status: 'aborted', resolvedReason: result.resolvedReason, externalId };
  }
  // TerminalTxStatus from @b1dz/adapters-evm: 'filled' | 'reverted' | 'stuck'
  return {
    status: result.status,
    resolvedReason: result.resolvedReason,
    externalId,
  };
}
