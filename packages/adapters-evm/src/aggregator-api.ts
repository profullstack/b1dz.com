/**
 * Swap-calldata fetchers for 0x and 1inch aggregators.
 *
 * These return ready-to-submit tx calldata for on-chain execution, unlike
 * the quote-only adapters (ZeroExAdapter / OneInchAdapter) which only fetch
 * indicative prices. A taker/from address is required so the aggregator can
 * route allowances correctly.
 *
 * 0x: uses the allowance-holder endpoint (avoids Permit2 / EIP-712 signing).
 * 1inch: uses the /swap endpoint (standard ERC20 approve + tx submit).
 */

import { EVM_CHAIN_IDS, type EvmChain } from './tokens.js';

const ZEROX_BASE_URL = 'https://api.0x.org';
const ONEINCH_BASE_URL = 'https://api.1inch.dev';

/** 1inch AggregationRouter v6 on Base — used as the allowanceTarget. */
const ONEINCH_ROUTER_BASE = '0x111111125421ca6dc452d289314280a0f8842a65';

export interface AggregatorSwapTx {
  to: string;
  data: string;
  value: bigint;
  gasLimit: bigint;
  /** ERC20 spender address the caller must have approved before submitting. */
  allowanceTarget: string;
}

interface ZeroExAllowanceHolderResponse {
  transaction: {
    to: string;
    data: string;
    value: string;
    gas: string;
    gasPrice: string;
  };
  allowanceTarget?: string;
}

interface OneInchSwapResponse {
  tx: {
    to: string;
    data: string;
    value: string;
    gas: number;
    gasPrice: string;
    from: string;
  };
}

/**
 * Fetch a firm swap tx from the 0x allowance-holder endpoint.
 * Returns null on unsupported pair, rate-limit, or API error.
 */
export async function fetchZeroExSwapTx(params: {
  chain: EvmChain;
  sellToken: string;
  buyToken: string;
  sellAmount: bigint;
  taker: string;
  slippageBps?: number;
  apiKey?: string;
}): Promise<AggregatorSwapTx | null> {
  const chainId = EVM_CHAIN_IDS[params.chain];
  const url = new URL('/swap/allowance-holder/quote', ZEROX_BASE_URL);
  url.searchParams.set('chainId', String(chainId));
  url.searchParams.set('sellToken', params.sellToken);
  url.searchParams.set('buyToken', params.buyToken);
  url.searchParams.set('sellAmount', params.sellAmount.toString());
  url.searchParams.set('taker', params.taker);
  if (params.slippageBps !== undefined) {
    url.searchParams.set('slippageBps', String(params.slippageBps));
  }

  const headers: Record<string, string> = { accept: 'application/json' };
  if (params.apiKey) {
    headers['0x-api-key'] = params.apiKey;
    headers['0x-version'] = 'v2';
  }

  const res = await fetch(url, { headers });
  if (!res.ok) {
    if (res.status === 400 || res.status === 404) return null;
    const text = await res.text().catch(() => '');
    throw new Error(`0x allowance-holder ${res.status}: ${text.slice(0, 200)}`);
  }

  const body = (await res.json()) as ZeroExAllowanceHolderResponse;
  const tx = body.transaction;
  if (!tx?.to || !tx?.data) return null;

  return {
    to: tx.to,
    data: tx.data,
    value: BigInt(tx.value ?? '0'),
    gasLimit: tx.gas ? BigInt(tx.gas) * 12n / 10n : 300_000n, // +20% safety margin
    allowanceTarget: body.allowanceTarget ?? tx.to,
  };
}

/**
 * Fetch a firm swap tx from the 1inch swap endpoint.
 * Returns null on unsupported pair or API error.
 */
export async function fetchOneInchSwapTx(params: {
  chain: EvmChain;
  src: string;
  dst: string;
  amount: bigint;
  from: string;
  slippageBps?: number;
  apiKey: string;
}): Promise<AggregatorSwapTx | null> {
  const chainId = EVM_CHAIN_IDS[params.chain];
  const slippagePct = ((params.slippageBps ?? 50) / 100).toFixed(2);
  const url = new URL(`/swap/v6.0/${chainId}/swap`, ONEINCH_BASE_URL);
  url.searchParams.set('src', params.src);
  url.searchParams.set('dst', params.dst);
  url.searchParams.set('amount', params.amount.toString());
  url.searchParams.set('from', params.from);
  url.searchParams.set('slippage', slippagePct);
  url.searchParams.set('disableEstimate', 'true');

  const res = await fetch(url, {
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${params.apiKey}`,
    },
  });
  if (!res.ok) {
    if (res.status === 400 || res.status === 404) return null;
    const text = await res.text().catch(() => '');
    throw new Error(`1inch swap ${res.status}: ${text.slice(0, 200)}`);
  }

  const body = (await res.json()) as OneInchSwapResponse;
  const tx = body.tx;
  if (!tx?.to || !tx?.data) return null;

  return {
    to: tx.to,
    data: tx.data,
    value: BigInt(tx.value ?? '0'),
    gasLimit: tx.gas ? BigInt(tx.gas) * 12n / 10n : 300_000n,
    allowanceTarget: ONEINCH_ROUTER_BASE,
  };
}
