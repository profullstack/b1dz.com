/**
 * Jupiter aggregator adapter for Solana (quote-only in MVP).
 *
 * Jupiter (lite-api.jup.ag) is a free public aggregator across every
 * significant Solana DEX. For quotes there's no auth and no wallet
 * required — good for `b1dz observe` ranking. Execution involves
 * signing and submitting a prepared transaction, which lands in the
 * next phase. See PRD.md §6.3 and §14.3.
 *
 * API docs: https://dev.jup.ag/docs/api
 * Quote:    GET https://lite-api.jup.ag/swap/v1/quote?inputMint=&outputMint=&amount=&slippageBps=
 */

import type { NormalizedQuote, QuoteRequest, VenueAdapter, AdapterHealth } from '@b1dz/venue-types';
import { mintFor, SOLANA_MINTS, toBaseUnits, fromBaseUnits } from './mints.js';

const BASE_URL = 'https://lite-api.jup.ag';

export interface JupiterAdapterOptions {
  baseUrl?: string;
  /** Default slippage in bps when the caller doesn't specify. */
  defaultSlippageBps?: number;
}

interface JupiterQuoteResponse {
  inputMint: string;
  inAmount: string;
  outputMint: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: 'ExactIn' | 'ExactOut';
  slippageBps: number;
  priceImpactPct?: string;
  routePlan: Array<{
    swapInfo: { ammKey: string; label: string; inputMint: string; outputMint: string; inAmount: string; outAmount: string; feeAmount: string; feeMint: string };
    percent: number;
  }>;
  contextSlot?: number;
}

export class JupiterAdapter implements VenueAdapter {
  readonly venue = 'jupiter';
  readonly venueType = 'aggregator' as const;
  readonly chain = 'solana';
  private readonly baseUrl: string;
  private readonly defaultSlippageBps: number;

  constructor(opts: JupiterAdapterOptions = {}) {
    this.baseUrl = opts.baseUrl ?? BASE_URL;
    this.defaultSlippageBps = opts.defaultSlippageBps ?? 50;
  }

  async health(): Promise<AdapterHealth> {
    const started = Date.now();
    try {
      const res = await this.rawQuote({
        inputMint: SOLANA_MINTS.USDC.mint,
        outputMint: SOLANA_MINTS.SOL.mint,
        amount: toBaseUnits('1', SOLANA_MINTS.USDC.decimals),
        slippageBps: this.defaultSlippageBps,
      });
      if (!res) return { ok: false, reason: 'empty response' };
      return { ok: true, latencyMs: Date.now() - started };
    } catch (e) {
      return { ok: false, reason: (e as Error).message.slice(0, 200) };
    }
  }

  async supports(req: QuoteRequest): Promise<boolean> {
    if (req.chain && req.chain !== 'solana') return false;
    const [base, quote] = req.pair.split('-');
    return !!(mintFor(base) && mintFor(quote));
  }

  async quote(req: QuoteRequest): Promise<NormalizedQuote | null> {
    if (!(await this.supports(req))) return null;
    const [baseSymbol, quoteSymbol] = req.pair.split('-');
    const baseMint = mintFor(baseSymbol)!;
    const quoteMint = mintFor(quoteSymbol)!;

    // side=buy → spend quote to get base. side=sell → spend base for quote.
    const inMint = req.side === 'buy' ? quoteMint : baseMint;
    const outMint = req.side === 'buy' ? baseMint : quoteMint;
    const amount = toBaseUnits(req.amountIn, inMint.decimals);

    const slippageBps = req.maxSlippageBps ?? this.defaultSlippageBps;
    const started = Date.now();
    const body = await this.rawQuote({
      inputMint: inMint.mint,
      outputMint: outMint.mint,
      amount,
      slippageBps,
    });
    if (!body) return null;

    const amountInDecimal = fromBaseUnits(body.inAmount, inMint.decimals);
    const amountOutDecimal = fromBaseUnits(body.outAmount, outMint.decimals);
    const unitPrice = Number.parseFloat(amountOutDecimal) / Number.parseFloat(amountInDecimal);
    const priceImpactBps = body.priceImpactPct
      ? Math.round(Number.parseFloat(body.priceImpactPct) * 10_000)
      : null;
    const routeSummary = body.routePlan.map((hop) => `${hop.swapInfo.label}(${hop.percent}%)`);

    return {
      venue: 'jupiter',
      venueType: 'aggregator',
      chain: 'solana',
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
      // Jupiter bakes per-pool fees into outAmount, so we don't double-count
      // them in feeUsd. Solana network fee + priority fee land in gasUsd.
      feeUsd: 0,
      // Typical Solana swap: base fee ~5k lamports + priority fee. At
      // SOL≈$150 this is ~$0.0001 for a base tx. We'll track an upper
      // bound of $0.005 until a real fee estimator lands.
      gasUsd: 0.005,
      slippageBps,
      priceImpactBps,
      routeHops: body.routePlan.length || 1,
      routeSummary,
      quoteTimestamp: started,
      expiresAt: null,
      latencyMs: Date.now() - started,
      allowanceRequired: false,
      approvalToken: null,
      tokenLifecycle: null,
      raw: body,
    };
  }

  private async rawQuote(params: {
    inputMint: string;
    outputMint: string;
    amount: string;
    slippageBps: number;
  }): Promise<JupiterQuoteResponse | null> {
    const url = new URL('/swap/v1/quote', this.baseUrl);
    url.searchParams.set('inputMint', params.inputMint);
    url.searchParams.set('outputMint', params.outputMint);
    url.searchParams.set('amount', params.amount);
    url.searchParams.set('slippageBps', String(params.slippageBps));

    const res = await fetch(url, { headers: { accept: 'application/json' } });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      if (res.status === 404 || res.status === 400) return null;
      throw new Error(`jupiter ${res.status}: ${text.slice(0, 200)}`);
    }
    const body = (await res.json()) as JupiterQuoteResponse;
    return body;
  }
}
