/**
 * 1inch v6 Swap API adapter (indicative quotes only in MVP).
 *
 * Similar shape to the 0x adapter — HTTP-only quote fetch, no wallet.
 * Execution requires signing 1inch calldata, which lands later.
 *
 * API docs: https://portal.1inch.dev/
 * Endpoint: GET https://api.1inch.dev/swap/v6.0/{chainId}/quote
 * Auth: Authorization: Bearer <API_KEY> (requires Dev Portal signup)
 */

import type { NormalizedQuote, QuoteRequest, VenueAdapter, AdapterHealth } from '@b1dz/venue-types';
import { EVM_CHAIN_IDS, TOKENS, tokenFor, toBaseUnits, fromBaseUnits, isEvmChain, type EvmChain } from './tokens.js';

const BASE_URL = 'https://api.1inch.dev';

export interface OneInchAdapterOptions {
  chain: EvmChain;
  apiKey?: string;
  baseUrl?: string;
}

interface OneInchQuoteResponse {
  dstAmount: string;
  /** Legacy v5 field; v6 returns dstAmount. */
  toAmount?: string;
  /** Gas estimate in gas units (not wei). */
  gas?: number;
  protocols?: Array<Array<Array<{ name: string; part: number }>>>;
}

export class OneInchAdapter implements VenueAdapter {
  readonly venue = '1inch';
  readonly venueType = 'aggregator' as const;
  readonly chain: EvmChain;
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;

  constructor(opts: OneInchAdapterOptions) {
    this.chain = opts.chain;
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl ?? BASE_URL;
  }

  async health(): Promise<AdapterHealth> {
    const chainTokens = TOKENS[this.chain];
    const usdc = chainTokens?.USDC;
    const weth = chainTokens?.WETH;
    if (!usdc || !weth) return { ok: false, reason: `no USDC/WETH on ${this.chain}` };
    const started = Date.now();
    try {
      const body = await this.rawQuote({
        src: usdc.address,
        dst: weth.address,
        amount: toBaseUnits('1', usdc.decimals),
      });
      if (!body) return { ok: false, reason: 'empty response' };
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
    const srcToken = req.side === 'buy' ? quoteToken : baseToken;
    const dstToken = req.side === 'buy' ? baseToken : quoteToken;
    const amount = toBaseUnits(req.amountIn, srcToken.decimals);

    const started = Date.now();
    const body = await this.rawQuote({
      src: srcToken.address,
      dst: dstToken.address,
      amount,
    });
    if (!body) return null;

    const dstAmount = body.dstAmount ?? body.toAmount ?? '0';
    if (dstAmount === '0') return null;

    const amountInDecimal = fromBaseUnits(amount, srcToken.decimals);
    const amountOutDecimal = fromBaseUnits(dstAmount, dstToken.decimals);
    const unitPrice = Number.parseFloat(amountOutDecimal) / Number.parseFloat(amountInDecimal);

    // 1inch doesn't return a gas price; we'll use the chain's rough native
    // USD price × estimated gas × assumed 1 gwei until the shared gas oracle
    // lands. Conservative: assume 20 gwei.
    const gasUnits = body.gas ?? 200_000;
    const gasPriceGwei = 20;
    const gasCostNative = (gasUnits * gasPriceGwei * 1e9) / 1e18;
    const gasUsd = gasCostNative * await this.nativeUsdPrice();

    const slippageBps = req.maxSlippageBps ?? 50;

    const routeSummary = (body.protocols?.[0]?.[0] ?? [])
      .filter((p) => p.part > 0)
      .map((p) => `${p.name}(${p.part}%)`);

    return {
      venue: '1inch',
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
      feeUsd: 0,
      gasUsd,
      slippageBps,
      priceImpactBps: null,
      routeHops: routeSummary.length || 1,
      routeSummary,
      quoteTimestamp: started,
      expiresAt: null,
      latencyMs: Date.now() - started,
      allowanceRequired: srcToken.address.toLowerCase() !== '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
      approvalToken: srcToken.address,
      tokenLifecycle: null,
      raw: body,
    };
  }

  private async rawQuote(params: { src: string; dst: string; amount: string }): Promise<OneInchQuoteResponse | null> {
    if (!this.apiKey) {
      throw new Error('1inch requires ONEINCH_API_KEY (free at https://portal.1inch.dev)');
    }
    const chainId = EVM_CHAIN_IDS[this.chain];
    const url = new URL(`/swap/v6.0/${chainId}/quote`, this.baseUrl);
    url.searchParams.set('src', params.src);
    url.searchParams.set('dst', params.dst);
    url.searchParams.set('amount', params.amount);

    const res = await fetch(url, {
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${this.apiKey}`,
      },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      if (res.status === 404 || res.status === 400) return null;
      throw new Error(`1inch ${res.status}: ${text.slice(0, 200)}`);
    }
    return (await res.json()) as OneInchQuoteResponse;
  }

  private async nativeUsdPrice(): Promise<number> {
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
