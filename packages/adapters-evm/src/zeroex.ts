/**
 * 0x Swap API adapter (indicative quotes only, no execution yet).
 *
 * 0x exposes a unified Swap API across all supported chains. For MVP we
 * only fetch quotes — execution requires a wallet and signed calldata,
 * which land in the next phase. See PRD.md §6.2 and §14.2.
 *
 * API docs: https://0x.org/docs/api
 * Endpoint: GET https://api.0x.org/swap/permit2/quote?chainId=<id>&...
 * Auth: header `0x-api-key: <key>` (free tier requires a key)
 */

import type { NormalizedQuote, QuoteRequest, VenueAdapter, AdapterHealth } from '@b1dz/venue-types';
import { EVM_CHAIN_IDS, TOKENS, tokenFor, toBaseUnits, fromBaseUnits, isEvmChain, type EvmChain } from './tokens.js';

const BASE_URL = 'https://api.0x.org';

export interface ZeroExAdapterOptions {
  chain: EvmChain;
  apiKey?: string;
  /** Override for testing or self-hosted proxies. */
  baseUrl?: string;
  /** Taker address for firm quotes. Indicative quotes work without it. */
  taker?: string;
}

interface ZeroExQuoteResponse {
  blockNumber: string;
  buyAmount: string;
  sellAmount: string;
  /** Price with fees baked in, expressed as buyAmount/sellAmount of base units. */
  price: string;
  guaranteedPrice?: string;
  totalNetworkFee: string;
  gas: string;
  gasPrice: string;
  estimatedPriceImpact?: string;
  sources?: Array<{ name: string; proportion: string }>;
  route?: { fills?: Array<{ source: string }> };
  allowanceTarget?: string;
  permit2?: { eip712: unknown };
}

export class ZeroExAdapter implements VenueAdapter {
  readonly venue = '0x';
  readonly venueType = 'aggregator' as const;
  readonly chain: EvmChain;
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;
  private readonly taker: string | undefined;

  constructor(opts: ZeroExAdapterOptions) {
    this.chain = opts.chain;
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl ?? BASE_URL;
    this.taker = opts.taker;
  }

  async health(): Promise<AdapterHealth> {
    // 0x doesn't have a dedicated health endpoint; a tiny USDC→WETH quote
    // is the cheapest "is the service up" probe.
    const chainTokens = TOKENS[this.chain];
    const usdc = chainTokens?.USDC;
    const weth = chainTokens?.WETH;
    if (!usdc || !weth) return { ok: false, reason: `no USDC/WETH on ${this.chain}` };
    const started = Date.now();
    try {
      const res = await this.rawQuote({
        sellToken: usdc.address,
        buyToken: weth.address,
        sellAmount: toBaseUnits('1', usdc.decimals),
      });
      if (!res) return { ok: false, reason: 'empty response' };
      return { ok: true, latencyMs: Date.now() - started };
    } catch (e) {
      return { ok: false, reason: (e as Error).message.slice(0, 200) };
    }
  }

  async supports(req: QuoteRequest): Promise<boolean> {
    if (req.chain && !isEvmChain(req.chain)) return false;
    if (req.chain && req.chain !== this.chain) return false;
    const [base, quote] = req.pair.split('-');
    return !!(tokenFor(this.chain, base) && tokenFor(this.chain, quote));
  }

  async quote(req: QuoteRequest): Promise<NormalizedQuote | null> {
    if (!(await this.supports(req))) return null;
    const [baseSymbol, quoteSymbol] = req.pair.split('-');
    const baseToken = tokenFor(this.chain, baseSymbol)!;
    const quoteToken = tokenFor(this.chain, quoteSymbol)!;

    // side=buy → spend quote to acquire base; sellToken=quote, buyToken=base.
    // side=sell → spend base to acquire quote; sellToken=base, buyToken=quote.
    const sellToken = req.side === 'buy' ? quoteToken : baseToken;
    const buyToken = req.side === 'buy' ? baseToken : quoteToken;
    const sellAmount = toBaseUnits(req.amountIn, sellToken.decimals);

    const started = Date.now();
    const body = await this.rawQuote({
      sellToken: sellToken.address,
      buyToken: buyToken.address,
      sellAmount,
      slippageBps: req.maxSlippageBps,
    });
    if (!body) return null;

    const gasWei = BigInt(body.gas ?? '0') * BigInt(body.gasPrice ?? '0');
    const gasEth = Number(gasWei) / 1e18;
    const gasUsd = gasEth * await this.nativeUsdPrice();
    const slippageBps = req.maxSlippageBps ?? 50;
    const priceImpactBps = body.estimatedPriceImpact
      ? Math.round(Number.parseFloat(body.estimatedPriceImpact) * 100)
      : null;

    const routeSummary = (body.sources ?? [])
      .filter((s) => Number.parseFloat(s.proportion) > 0)
      .map((s) => `${s.name}(${(Number.parseFloat(s.proportion) * 100).toFixed(0)}%)`);

    // Convert wire amounts back to decimals for NormalizedQuote consumers.
    const amountInDecimal = fromBaseUnits(body.sellAmount, sellToken.decimals);
    const amountOutDecimal = fromBaseUnits(body.buyAmount, buyToken.decimals);
    const unitPrice = Number.parseFloat(amountOutDecimal) / Number.parseFloat(amountInDecimal);

    return {
      venue: '0x',
      venueType: 'aggregator',
      chain: this.chain,
      dexProtocol: null,
      pair: req.pair,
      baseAsset: baseSymbol,
      quoteAsset: quoteSymbol,
      amountIn: amountInDecimal,
      amountOut: amountOutDecimal,
      amountInUsd: null,
      amountOutUsd: null,
      side: req.side,
      estimatedUnitPrice: unitPrice.toString(),
      feeUsd: 0, // 0x itself adds 0 protocol fee on most routes; underlying AMM fees are in `price`.
      gasUsd,
      slippageBps,
      priceImpactBps,
      routeHops: routeSummary.length || 1,
      routeSummary,
      quoteTimestamp: started,
      expiresAt: null,
      latencyMs: Date.now() - started,
      allowanceRequired: !!body.allowanceTarget && sellToken.address.toLowerCase() !== '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
      approvalToken: sellToken.address,
      tokenLifecycle: null,
      raw: body,
    };
  }

  private async rawQuote(params: {
    sellToken: string;
    buyToken: string;
    sellAmount: string;
    slippageBps?: number;
  }): Promise<ZeroExQuoteResponse | null> {
    const url = new URL('/swap/permit2/quote', this.baseUrl);
    url.searchParams.set('chainId', String(EVM_CHAIN_IDS[this.chain]));
    url.searchParams.set('sellToken', params.sellToken);
    url.searchParams.set('buyToken', params.buyToken);
    url.searchParams.set('sellAmount', params.sellAmount);
    if (params.slippageBps !== undefined) url.searchParams.set('slippageBps', String(params.slippageBps));
    if (this.taker) url.searchParams.set('taker', this.taker);

    const headers: Record<string, string> = { accept: 'application/json' };
    if (this.apiKey) {
      headers['0x-api-key'] = this.apiKey;
      headers['0x-version'] = 'v2';
    }

    const res = await fetch(url, { headers });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      // 404 / validation errors come back as normal-looking JSON;
      // surface them as null so the ranker treats this venue as unsupported
      // for this request rather than crashing the entire scan.
      if (res.status === 404 || res.status === 400) return null;
      throw new Error(`0x ${res.status}: ${text.slice(0, 200)}`);
    }
    return (await res.json()) as ZeroExQuoteResponse;
  }

  /** Rough USD price for the chain's native gas asset.
   *  For MVP we skip an external price feed and return a hardcoded number
   *  per chain. The profitability engine will eventually pull this from
   *  a shared price oracle. */
  private async nativeUsdPrice(): Promise<number> {
    // Placeholder so gasUsd isn't wildly wrong. Replace with a real quote
    // against the same 0x call (ETH→USDC 1e18) when the oracle lands.
    const roughPrices: Record<EvmChain, number> = {
      ethereum: 2500,
      base: 2500,
      avalanche: 30,
      arbitrum: 2500,
      optimism: 2500,
      polygon: 0.5,
    };
    return roughPrices[this.chain] ?? 0;
  }
}
