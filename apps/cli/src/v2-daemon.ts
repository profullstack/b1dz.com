/**
 * `b1dz v2-daemon` — the v2 trade daemon worker.
 *
 * For MVP this command runs an in-memory self-test (observer + daemon
 * in the same process) to prove the pipeline works end-to-end. When
 * the Supabase-backed channel is wired into a real deployment, this
 * command will be the production-mode entry point that points at the
 * shared queue.
 */

import { ZeroExAdapter, OneInchAdapter } from '@b1dz/adapters-evm';
import { JupiterAdapter } from '@b1dz/adapters-solana';
import { defaultCexAdapters } from '@b1dz/adapters-cex';
import { InMemoryEventChannel } from '@b1dz/event-channel';
import { ObserveEngine, type ObservePair } from '@b1dz/observe-engine';
import { TradeDaemon, type TradeMode } from '@b1dz/trade-daemon';
import type { VenueAdapter } from '@b1dz/venue-types';

interface Args {
  mode: TradeMode;
  pair: string;
  amount: string;
  chain: string;
  intervalMs: number;
  minNetUsd: number;
  minNetBps: number;
}

function parseArgs(argv: string[]): Args {
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (!t.startsWith('--')) continue;
    const key = t.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      flags[key] = next;
      i++;
    } else {
      flags[key] = 'true';
    }
  }
  const mode = (flags.mode ?? 'paper') as TradeMode;
  if (!['observe', 'paper', 'live'].includes(mode)) {
    throw new Error(`invalid mode "${mode}" — expected observe|paper|live`);
  }
  return {
    mode,
    pair: flags.pair ?? 'SOL-USDC',
    amount: flags.amount ?? '1',
    chain: flags.chain ?? 'all',
    intervalMs: Math.max(500, Number.parseInt(flags.interval ?? '3000', 10)),
    minNetUsd: Number.parseFloat(flags['min-net'] ?? '0.01'),
    minNetBps: Number.parseFloat(flags['min-bps'] ?? '1'),
  };
}

function buildAdapters(chain: string): VenueAdapter[] {
  if (chain === 'cex') return defaultCexAdapters();
  if (chain === 'all') {
    const list: VenueAdapter[] = [...defaultCexAdapters(), new JupiterAdapter()];
    list.push(new ZeroExAdapter({ chain: 'base', apiKey: process.env.ZEROX_API_KEY }));
    if (process.env.ONEINCH_API_KEY) {
      list.push(new OneInchAdapter({ chain: 'base', apiKey: process.env.ONEINCH_API_KEY }));
    }
    return list;
  }
  if (chain === 'solana') return [new JupiterAdapter()];
  return [];
}

export async function runV2DaemonCli(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const adapters = buildAdapters(args.chain);
  if (adapters.length === 0) {
    throw new Error(`no adapters enabled for chain "${args.chain}"`);
  }

  const channel = new InMemoryEventChannel();
  const pair: ObservePair = {
    pair: args.pair,
    sizeUsd: Number.parseFloat(args.amount),
    baseAmountForSellSide: args.amount,
    quoteAmountForBuySide: args.amount,
  };

  const observer = new ObserveEngine({
    pairs: [pair],
    adapters,
    channel,
    intervalMs: args.intervalMs,
    minNetUsd: args.minNetUsd,
    minNetBps: args.minNetBps,
  });

  const daemon = new TradeDaemon({
    channel,
    mode: args.mode,
    pollIntervalMs: Math.max(500, Math.floor(args.intervalMs / 3)),
    batchSize: 10,
    risk: {
      maxTradeUsd: 1000,
      minNetUsd: args.minNetUsd,
      minNetBps: args.minNetBps,
    },
  });

  console.log(`b1dz v2-daemon  mode=${args.mode}  pair=${args.pair}  amount=${args.amount}  chain=${args.chain}`);
  console.log(`  venues: ${adapters.map((a) => a.venue).join(', ')}`);
  console.log(`  tick=${args.intervalMs}ms  min-net=$${args.minNetUsd}  min-bps=${args.minNetBps}`);
  console.log('  Ctrl+C to stop\n');

  observer.start();
  daemon.start();

  const cleanup = () => {
    observer.stop();
    daemon.stop();
    process.exit(0);
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
  await new Promise(() => {}); // run forever
}
