/**
 * DEX aggregator executor — 0x (allowance-holder) and 1inch swap API.
 *
 * Handles the BUY leg of opportunities where buyVenue is '0x' or '1inch'
 * on Base chain. Fetches firm swap calldata from the aggregator API,
 * ensures ERC20 approval is in place, then submits the tx via WalletService.
 *
 * Arming: requires EVM_PRIVATE_KEY + BASE_RPC_URL + at least one of
 * ZEROX_API_KEY / ONEINCH_API_KEY, and ARB_MODE=live.
 * Opt out with ARB_EXECUTOR_AGGREGATOR=false.
 */

import type { Executor, ExecutorOutcome } from '@b1dz/trade-daemon';
import type { Opportunity } from '@b1dz/venue-types';
import type { WalletService } from '@b1dz/wallet-service';
import {
  checkApproval,
  buildApprovalTx,
  TOKENS,
  toBaseUnits,
  type Address,
  type Hex,
  type PublicClient,
} from '@b1dz/adapters-evm';
import { fetchZeroExSwapTx, fetchOneInchSwapTx } from '@b1dz/adapters-evm';

export interface AggregatorBaseExecutorArgs {
  walletService: WalletService;
  walletAddress: Address;
  publicClient: PublicClient;
  maxTradeUsd: number;
  zeroxApiKey?: string;
  oneinchApiKey?: string;
  log?: (msg: string) => void;
}

export class AggregatorBaseExecutor implements Executor {
  private readonly walletService: WalletService;
  private readonly walletAddress: Address;
  private readonly publicClient: PublicClient;
  private readonly maxTradeUsd: number;
  private readonly zeroxApiKey: string | undefined;
  private readonly oneinchApiKey: string | undefined;
  private readonly log: (msg: string) => void;

  constructor(args: AggregatorBaseExecutorArgs) {
    this.walletService = args.walletService;
    this.walletAddress = args.walletAddress;
    this.publicClient = args.publicClient;
    this.maxTradeUsd = args.maxTradeUsd;
    this.zeroxApiKey = args.zeroxApiKey;
    this.oneinchApiKey = args.oneinchApiKey;
    this.log = args.log ?? ((m) => console.log(m));
  }

  canExecute(opp: Opportunity): boolean {
    if (opp.buyVenue !== '0x' && opp.buyVenue !== '1inch') return false;
    if (opp.buyChain !== 'base') return false;
    if (opp.buyQuote?.quoteAsset?.toUpperCase() !== 'USDC') return false;
    if (opp.buyVenue === '0x' && !this.zeroxApiKey) return false;
    if (opp.buyVenue === '1inch' && !this.oneinchApiKey) return false;
    return true;
  }

  async execute(opp: Opportunity): Promise<ExecutorOutcome> {
    try {
      return await this._execute(opp);
    } catch (e) {
      return abort(`unexpected error: ${(e as Error).message.slice(0, 200)}`);
    }
  }

  private async _execute(opp: Opportunity): Promise<ExecutorOutcome> {
    const sizeUsd = Number.parseFloat(opp.size);
    if (!Number.isFinite(sizeUsd) || sizeUsd <= 0) {
      return abort(`invalid size "${opp.size}"`);
    }
    if (sizeUsd > this.maxTradeUsd) {
      return abort(`size $${sizeUsd.toFixed(2)} > executor cap $${this.maxTradeUsd}`);
    }

    const baseSymbol = opp.buyQuote.baseAsset.toUpperCase();
    const baseTokens = TOKENS.base;
    if (!baseTokens) return abort('no base-chain token registry');

    const tokenIn = baseTokens['USDC'];
    const tokenOut = baseTokens[baseSymbol];
    if (!tokenIn) return abort('USDC not in base registry');
    if (!tokenOut) return abort(`tokenOut ${baseSymbol} not in base registry`);

    let amountIn: bigint;
    try {
      amountIn = BigInt(toBaseUnits(opp.buyQuote.amountIn, tokenIn.decimals));
    } catch (e) {
      return abort(`amountIn parse failed: ${(e as Error).message.slice(0, 120)}`);
    }
    if (amountIn === 0n) return abort('amountIn resolved to 0 base units');

    // Fetch swap calldata from aggregator.
    let swapTx: Awaited<ReturnType<typeof fetchZeroExSwapTx>>;
    try {
      if (opp.buyVenue === '0x') {
        swapTx = await fetchZeroExSwapTx({
          chain: 'base',
          sellToken: tokenIn.address,
          buyToken: tokenOut.address,
          sellAmount: amountIn,
          taker: this.walletAddress,
          slippageBps: opp.buyQuote.slippageBps ?? 50,
          apiKey: this.zeroxApiKey,
        });
      } else {
        swapTx = await fetchOneInchSwapTx({
          chain: 'base',
          src: tokenIn.address,
          dst: tokenOut.address,
          amount: amountIn,
          from: this.walletAddress,
          slippageBps: opp.buyQuote.slippageBps ?? 50,
          apiKey: this.oneinchApiKey!,
        });
      }
    } catch (e) {
      return abort(`${opp.buyVenue} swap fetch failed: ${(e as Error).message.slice(0, 160)}`);
    }
    if (!swapTx) return abort(`${opp.buyVenue} returned no swap tx for ${baseSymbol}`);

    // Check and submit ERC20 approval if needed.
    const approvalNeed = await checkApproval({
      client: this.publicClient,
      token: tokenIn.address as Address,
      owner: this.walletAddress,
      spender: swapTx.allowanceTarget as Address,
      required: amountIn,
      mode: 'exact',
    });

    if (approvalNeed.needed) {
      this.log(`[aggregator] approving ${tokenIn.symbol} → ${swapTx.allowanceTarget} amount=${amountIn}`);
      const approvalTx = buildApprovalTx(approvalNeed);
      const approvalResult = await this.walletService.execute({
        chain: 'base',
        from: this.walletAddress,
        to: approvalTx.to,
        data: approvalTx.data as Hex,
        value: approvalTx.value,
        gasLimit: approvalTx.gasLimit,
      });
      if (approvalResult.status !== 'filled') {
        return abort(`approval tx ${approvalResult.status}: ${approvalResult.resolvedReason}`);
      }
    }

    this.log(
      `[aggregator] BUY ${baseSymbol} via ${opp.buyVenue} amountIn=${opp.buyQuote.amountIn} USDC` +
      ` slippage=${opp.buyQuote.slippageBps ?? 50}bps`,
    );

    const result = await this.walletService.execute({
      chain: 'base',
      from: this.walletAddress,
      to: swapTx.to as Address,
      data: swapTx.data as Hex,
      value: swapTx.value,
      gasLimit: swapTx.gasLimit,
    });

    const externalId = result.txHash ?? undefined;
    if (result.status === 'aborted') {
      return { status: 'aborted', resolvedReason: result.resolvedReason, externalId };
    }
    return { status: result.status, resolvedReason: result.resolvedReason, externalId };
  }
}

function abort(reason: string): ExecutorOutcome {
  return { status: 'aborted', resolvedReason: reason };
}
