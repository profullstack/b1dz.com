/**
 * `b1dz pumpfun discover` — list new Pump.fun launches and their
 * lifecycle state. Observe-only; guarded behind PUMPFUN_ENABLE_SCRAPE
 * per PRD §27.
 */
import { PumpFunDiscoveryAdapter, type PumpFunTokenCandidate } from '@b1dz/adapters-pumpfun';
import type { TokenLifecycle } from '@b1dz/venue-types';

interface Args {
  subcommand: 'discover';
  minMcap: number;
  maxAgeMinutes: number;
  lifecycle: TokenLifecycle[];
  limit: number;
}

const ALL_LIFECYCLES: TokenLifecycle[] = ['new_launch', 'bonding_curve', 'migrating', 'pumpswap', 'external_pool'];

function parseArgs(argv: string[]): Args {
  const [sub = 'discover', ...rest] = argv;
  if (sub !== 'discover') {
    throw new Error(`unknown pumpfun subcommand "${sub}"`);
  }
  const flags: Record<string, string> = {};
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = rest[i + 1];
    if (next && !next.startsWith('--')) {
      flags[key] = next;
      i++;
    } else {
      flags[key] = 'true';
    }
  }
  const minMcap = Number.parseFloat(flags['min-mcap'] ?? '1000');
  const maxAgeMinutes = Number.parseFloat(flags['max-age'] ?? '60');
  const limit = Math.max(1, Math.min(50, Number.parseInt(flags.limit ?? '20', 10)));
  const lifecycleArg = flags.lifecycle;
  const lifecycle = lifecycleArg
    ? lifecycleArg.split(',').map((s) => s.trim()).filter((s): s is TokenLifecycle => (ALL_LIFECYCLES as string[]).includes(s))
    : [];
  return { subcommand: 'discover', minMcap, maxAgeMinutes, lifecycle, limit };
}

function fmtAge(ms: number): string {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  return `${h}h${min % 60}m`;
}

function renderRow(t: PumpFunTokenCandidate, now: number): string {
  const state = t.lifecycle.padEnd(14);
  const sym = (t.symbol ?? '').slice(0, 10).padEnd(10);
  const mcap = `$${Math.round(t.marketCapUsd).toLocaleString()}`.padStart(10);
  const age = fmtAge(now - t.createdAtMs).padStart(6);
  const replies = `r=${t.replyCount}`.padEnd(6);
  const mint = t.mint.slice(0, 8) + '…' + t.mint.slice(-4);
  return `  ${state} ${sym} mcap=${mcap} age=${age} ${replies} ${mint}  ${t.name.slice(0, 32)}`;
}

export async function runPumpfunCli(argv: string[]): Promise<void> {
  const args = parseArgs(argv);

  const scrapeEnabled = process.env.PUMPFUN_ENABLE_SCRAPE === 'true';
  if (!scrapeEnabled) {
    console.log('PUMPFUN_ENABLE_SCRAPE=true is required (PRD §27 — scrape sources need explicit opt-in)');
    console.log('');
    console.log('  PUMPFUN_ENABLE_SCRAPE=true b1dz pumpfun discover');
    return;
  }

  const adapter = new PumpFunDiscoveryAdapter({ enableScrape: true, pageLimit: 50 });
  console.log(`b1dz pumpfun discover  min-mcap=$${args.minMcap}  max-age=${args.maxAgeMinutes}m  lifecycle=${args.lifecycle.length ? args.lifecycle.join(',') : 'all'}  limit=${args.limit}\n`);

  const candidates = await adapter.discover({
    minMarketCapUsd: args.minMcap,
    maxAgeMinutes: args.maxAgeMinutes,
    lifecycleAllowlist: args.lifecycle.length > 0 ? args.lifecycle : undefined,
  });

  if (candidates.length === 0) {
    console.log('no candidates match the filters');
    return;
  }

  const now = Date.now();
  const sorted = [...candidates]
    .sort((a, b) => b.marketCapUsd - a.marketCapUsd)
    .slice(0, args.limit);
  for (const t of sorted) {
    console.log(renderRow(t, now));
  }
  console.log(`\n  ${sorted.length} of ${candidates.length} candidates shown`);
}
