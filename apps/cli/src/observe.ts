/**
 * `b1dz observe` — real-time multi-venue quote scanner.
 *
 * First slice: fetch a NormalizedQuote from every enabled DEX/aggregator
 * adapter for a single pair and size, then print them side-by-side so
 * the operator can see where the best fill is. No execution, no wallet.
 *
 * Intended to grow into the PRD §11A streaming scanner — this is the
 * synchronous "show me the board once" entry point that proves the
 * adapter interface works end-to-end. The streaming loop + trade
 * daemon wire-up come next.
 *
 * Usage:
 *   b1dz observe --pair ETH-USDC --amount 100 --side buy --chain base
 *   b1dz observe --pair SOL-USDC --amount 100 --side buy --chain solana
 *   b1dz observe --pair USDC-ETH --amount 0.01 --side sell --chain base
 */
import { ZeroExAdapter, OneInchAdapter, type EvmChain, isEvmChain } from '@b1dz/adapters-evm';
import { JupiterAdapter } from '@b1dz/adapters-solana';
import { defaultCexAdapters } from '@b1dz/adapters-cex';
import type { NormalizedQuote, QuoteRequest, VenueAdapter } from '@b1dz/venue-types';

interface ObserveArgs {
  pair: string;
  side: 'buy' | 'sell';
  amount: string;
  chain: string;
  slippageBps: number;
}

function parseArgs(argv: string[]): ObserveArgs {
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      flags[key] = next;
      i++;
    } else {
      flags[key] = 'true';
    }
  }
  const pair = flags.pair ?? 'ETH-USDC';
  const side = (flags.side ?? 'buy') as 'buy' | 'sell';
  if (side !== 'buy' && side !== 'sell') {
    throw new Error(`invalid side "${side}" — expected buy or sell`);
  }
  const amount = flags.amount ?? '100';
  const chain = flags.chain ?? 'base';
  const slippageBps = Number.parseInt(flags.slippage ?? '50', 10);
  return { pair, side, amount, chain, slippageBps };
}

function buildAdaptersFor(chain: string): VenueAdapter[] {
  if (chain === 'cex') {
    return defaultCexAdapters();
  }
  if (chain === 'all') {
    // Compare every venue in parallel — CEXs + EVM aggregators (Base is the
    // default evm chain here since it's cheap and MVP-scoped) + Jupiter.
    const zerox = new ZeroExAdapter({ chain: 'base', apiKey: process.env.ZEROX_API_KEY });
    const oneinch = process.env.ONEINCH_API_KEY
      ? new OneInchAdapter({ chain: 'base', apiKey: process.env.ONEINCH_API_KEY })
      : null;
    return [
      ...defaultCexAdapters(),
      zerox,
      ...(oneinch ? [oneinch] : []),
      new JupiterAdapter(),
    ];
  }
  if (isEvmChain(chain)) {
    const adapters: VenueAdapter[] = [
      new ZeroExAdapter({ chain: chain as EvmChain, apiKey: process.env.ZEROX_API_KEY }),
    ];
    if (process.env.ONEINCH_API_KEY) {
      adapters.push(new OneInchAdapter({ chain: chain as EvmChain, apiKey: process.env.ONEINCH_API_KEY }));
    }
    return adapters;
  }
  if (chain === 'solana') {
    return [new JupiterAdapter()];
  }
  return [];
}

function renderRow(q: NormalizedQuote): string {
  const venue = q.venue.padEnd(10);
  const route = (q.routeSummary.slice(0, 2).join(' ') || '-').padEnd(28);
  const out = `${Number.parseFloat(q.amountOut).toFixed(6)} ${q.quoteAsset}`.padEnd(24);
  const price = Number.parseFloat(q.estimatedUnitPrice).toFixed(6);
  const gas = `gas=$${q.gasUsd.toFixed(4)}`.padEnd(14);
  const hops = `hops=${q.routeHops}`.padEnd(7);
  const pi = q.priceImpactBps != null ? `pi=${(q.priceImpactBps / 100).toFixed(2)}%` : 'pi=?';
  const latency = `${q.latencyMs}ms`;
  return `  ${venue} out=${out} px=${price}  ${gas}${hops}${pi.padEnd(11)}${latency}  [${route}]`;
}

export async function runObserveCli(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  console.log(`b1dz observe  pair=${args.pair} side=${args.side} amount=${args.amount} chain=${args.chain} slippage=${args.slippageBps}bps\n`);

  const adapters = buildAdaptersFor(args.chain);
  if (adapters.length === 0) {
    console.log(`no adapters enabled for chain "${args.chain}"`);
    console.log('supported: base, avalanche, ethereum, arbitrum, optimism, polygon, solana');
    return;
  }

  // When chain='all' or 'cex' we don't want to force a chain match — each
  // adapter should answer for its own venue. Only scope the request to a
  // specific chain when the user asked for one directly.
  const scopedChain = args.chain === 'all' || args.chain === 'cex' ? undefined : args.chain;

  const results = await Promise.all(adapters.map(async (a) => {
    const req: QuoteRequest = {
      pair: args.pair,
      side: args.side,
      amountIn: args.amount,
      ...(scopedChain !== undefined ? { chain: scopedChain } : {}),
      maxSlippageBps: args.slippageBps,
    };
    try {
      const q = await a.quote(req);
      return { adapter: a, quote: q, error: null as string | null };
    } catch (e) {
      return { adapter: a, quote: null, error: (e as Error).message };
    }
  }));

  for (const r of results) {
    if (r.error) {
      console.log(`  ${r.adapter.venue.padEnd(10)} ERROR: ${r.error.slice(0, 100)}`);
      continue;
    }
    if (!r.quote) {
      console.log(`  ${r.adapter.venue.padEnd(10)} no quote (pair/chain not supported or no liquidity)`);
      continue;
    }
    console.log(renderRow(r.quote));
  }

  // Highlight the best fill (highest amountOut in the quote asset).
  const quotes = results.map((r) => r.quote).filter((q): q is NormalizedQuote => !!q);
  if (quotes.length >= 2) {
    const best = quotes.reduce((a, b) => Number.parseFloat(a.amountOut) > Number.parseFloat(b.amountOut) ? a : b);
    console.log(`\n  best fill: ${best.venue} at ${Number.parseFloat(best.amountOut).toFixed(6)} ${best.quoteAsset}`);
  }
}
