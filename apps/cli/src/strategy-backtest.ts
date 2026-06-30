/**
 * `b1dz strategy-backtest` — replay a plugin-store / TSP strategy over history.
 *
 * Unlike `b1dz backtest <tf>` (the server-side multi-pair crypto candle sim),
 * this runs locally against the deterministic StrategyPlugin engine in
 * @b1dz/source-strategies: it replays the strategy's own buy/sell signals
 * long-only over Yahoo daily bars.
 *
 * Crucially it scores crypto and equities SEPARATELY so you can see which asset
 * class a strategy suits. Run both (default, with a head-to-head verdict),
 * or restrict to one with --crypto / --equities.
 *
 *   b1dz strategy-backtest mean-reversion          # both classes, compared
 *   b1dz strategy-backtest all --crypto            # every built-in, crypto only
 *   b1dz strategy-backtest --equities --file my.tsp.json
 *   b1dz strategy-backtest trend-continuation --amount 250
 */
import { readFileSync } from 'node:fs';
import chalk from 'chalk';
import Table from 'cli-table3';
import { PLUGIN_CATALOG, type MarketSnapshot, type StrategyPlugin } from '@b1dz/core';
import {
  STRATEGY_PLUGINS,
  replayStrategy,
  summarizeTrades,
  tsp,
  type BacktestSummary,
} from '@b1dz/source-strategies';

const CRYPTO_BASKET = ['BTC-USD', 'ETH-USD', 'SOL-USD'];
const EQUITY_BASKET = ['SPY', 'AAPL', 'NVDA'];
const DAY_MS = 24 * 60 * 60 * 1000;
const MIN_BARS = 35; // enough for the slowest indicator (MACD/trend)

const HORIZONS = [
  { label: '1 month', months: 1 },
  { label: '3 months', months: 3 },
  { label: '6 months', months: 6 },
  { label: '1 year', years: 1 },
  { label: '2 years', years: 2 },
  { label: '5 years', years: 5 },
] as const;

type AssetClass = 'crypto' | 'equity';

interface ClassResult {
  assetClass: AssetClass;
  basket: string[];
  symbolsWithData: string[];
  horizons: { label: string; startYmd: string; endYmd: string; summary: BacktestSummary }[];
  /** Longest available horizon's summary — the headline used for the verdict. */
  headline: { label: string; summary: BacktestSummary } | null;
}

// ── args ─────────────────────────────────────────────────────────────────────
interface Args {
  selector: string | null; // strategy id, 'all', or null
  file: string | null;
  classes: AssetClass[];
  amount: number;
}

export function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i]!;
    if (t.startsWith('--')) {
      const key = t.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = 'true';
      }
    } else {
      positional.push(t);
    }
  }
  const wantCrypto = flags.crypto === 'true';
  const wantEquities = flags.equities === 'true' || flags.equity === 'true';
  const classes: AssetClass[] =
    wantCrypto && !wantEquities ? ['crypto'] : wantEquities && !wantCrypto ? ['equity'] : ['crypto', 'equity'];
  const amount = Math.max(1, Number.parseFloat(flags.amount ?? '100'));
  return {
    selector: positional[0] ?? (flags.strategy ?? null),
    file: flags.file ?? null,
    classes,
    amount,
  };
}

// ── data ─────────────────────────────────────────────────────────────────────
function pad(n: number): string {
  return String(n).padStart(2, '0');
}
function ymd(date: Date): string {
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}
function subtract(end: Date, h: (typeof HORIZONS)[number]): Date {
  const d = new Date(end);
  if ('months' in h) d.setUTCMonth(d.getUTCMonth() - h.months);
  else d.setUTCFullYear(d.getUTCFullYear() - h.years);
  return d;
}

async function fetchDailySnapshots(symbol: string, startMs: number, endMs: number): Promise<MarketSnapshot[]> {
  const period1 = Math.floor((startMs - 7 * DAY_MS) / 1000);
  const period2 = Math.floor((endMs + 7 * DAY_MS) / 1000);
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
    `?period1=${period1}&period2=${period2}&interval=1d&events=history`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Yahoo HTTP ${res.status} for ${symbol}`);
  const json = (await res.json()) as {
    chart?: { result?: { timestamp?: number[]; indicators?: { quote?: { close?: (number | null)[] }[] } }[]; error?: { description?: string } };
  };
  const result = json.chart?.result?.[0];
  if (!result?.timestamp?.length) throw new Error(json.chart?.error?.description ?? `no data for ${symbol}`);
  const close = result.indicators?.quote?.[0]?.close ?? [];
  const assetClass: AssetClass = symbol.includes('-USD') ? 'crypto' : 'equity';
  return result.timestamp
    .map((t, i) => ({ t: t * 1000, c: close[i] }))
    .filter((b): b is { t: number; c: number } => Number.isFinite(b.c))
    .sort((a, b) => a.t - b.t)
    .map((b) => ({ exchange: 'yahoo', pair: symbol, bid: b.c, ask: b.c, bidSize: 1, askSize: 1, ts: b.t, assetClass }));
}

async function backtestClass(plugin: StrategyPlugin, assetClass: AssetClass, amount: number): Promise<ClassResult> {
  const basket = assetClass === 'crypto' ? CRYPTO_BASKET : EQUITY_BASKET;
  const now = new Date();
  const endMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const startMs = subtract(now, HORIZONS[HORIZONS.length - 1]!).getTime();

  const series = new Map<string, MarketSnapshot[]>();
  for (const symbol of basket) {
    try {
      series.set(symbol, await fetchDailySnapshots(symbol, startMs, endMs));
    } catch (e) {
      process.stderr.write(chalk.dim(`  (skipping ${symbol}: ${(e as Error).message})\n`));
    }
  }

  const horizons = HORIZONS.map((h) => {
    const hStart = subtract(now, h).getTime();
    const trades = [...series.values()].flatMap((snaps) => {
      const window = snaps.filter((s) => s.ts >= hStart);
      return window.length < MIN_BARS ? [] : replayStrategy(plugin, window, amount);
    });
    return { label: h.label, startYmd: ymd(new Date(hStart)), endYmd: ymd(new Date(endMs)), summary: summarizeTrades(trades) };
  });

  const headline = [...horizons].reverse().find((h) => h.summary.trades > 0) ?? null;
  return {
    assetClass,
    basket,
    symbolsWithData: [...series.keys()],
    horizons,
    headline: headline ? { label: headline.label, summary: headline.summary } : null,
  };
}

// ── rendering ────────────────────────────────────────────────────────────────
function fmtPct(n: number): string {
  const s = `${n >= 0 ? '+' : ''}${(n * 100).toFixed(2)}%`;
  return n >= 0 ? chalk.green(s) : chalk.red(s);
}
function fmtUsd(n: number): string {
  return `${n >= 0 ? '+' : '-'}$${Math.abs(n).toFixed(2)}`;
}

function renderClass(r: ClassResult): void {
  const label = r.assetClass === 'crypto' ? 'CRYPTO' : 'EQUITIES';
  console.log(`\n${chalk.bold.cyan(label)}  ${chalk.dim(r.symbolsWithData.join(', ') || '(no data)')}`);
  const table = new Table({
    head: ['Horizon', 'Trades', 'Win%', 'Return', 'Profit', 'MaxDD'].map((h) => chalk.dim(h)),
    style: { head: [], border: [] },
    colAligns: ['left', 'right', 'right', 'right', 'right', 'right'],
  });
  for (const h of r.horizons) {
    const s = h.summary;
    table.push([
      h.label,
      String(s.trades),
      `${Math.round(s.winRate * 100)}%`,
      fmtPct(s.returnPct),
      fmtUsd(s.profit),
      `$${s.maxDrawdown.toFixed(0)}`,
    ]);
  }
  console.log(table.toString());
}

function renderVerdict(results: ClassResult[]): void {
  const withHeadline = results.filter((r) => r.headline);
  if (withHeadline.length < 2) return;
  const [a, b] = [...withHeadline].sort((x, y) => y.headline!.summary.returnPct - x.headline!.summary.returnPct);
  const winner = a!.assetClass === 'crypto' ? 'crypto' : 'equities';
  const ra = a!.headline!;
  const rb = b!.headline!;
  console.log(`\n${chalk.bold('Head-to-head')} (best common window):`);
  console.log(
    `  ${chalk.cyan(a!.assetClass.padEnd(7))} ${fmtPct(ra.summary.returnPct)} over ${ra.label} ` +
      `(${Math.round(ra.summary.winRate * 100)}% win, ${ra.summary.trades} trades)`,
  );
  console.log(
    `  ${chalk.cyan(b!.assetClass.padEnd(7))} ${fmtPct(rb.summary.returnPct)} over ${rb.label} ` +
      `(${Math.round(rb.summary.winRate * 100)}% win, ${rb.summary.trades} trades)`,
  );
  console.log(`  ${chalk.bold(`→ Better fit for ${chalk.green(winner)}`)}`);
}

// ── strategy selection ───────────────────────────────────────────────────────
function listAvailable(): void {
  const ids = STRATEGY_PLUGINS.map((p) => p.manifest.id);
  console.log('Available strategies (or pass --file <doc.tsp.json>):');
  for (const p of STRATEGY_PLUGINS) {
    const entry = PLUGIN_CATALOG.find((e) => e.manifest.id === p.manifest.id);
    console.log(`  ${chalk.cyan(p.manifest.id.padEnd(20))} ${entry?.tagline ?? p.manifest.name}`);
  }
  console.log(`\nUsage: b1dz strategy-backtest <${ids.join('|')}|all> [--crypto|--equities] [--amount 100]`);
}

function selectPlugins(args: Args): StrategyPlugin[] {
  if (args.file) {
    const doc = JSON.parse(readFileSync(args.file, 'utf8'));
    return [tsp.compile(doc)]; // throws with readable errors if invalid
  }
  if (!args.selector) return [];
  if (args.selector === 'all') return STRATEGY_PLUGINS;
  const match = STRATEGY_PLUGINS.find((p) => p.manifest.id === args.selector);
  if (!match) throw new Error(`unknown strategy "${args.selector}" — run with no args to list available ones`);
  return [match];
}

export async function runStrategyBacktestCli(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const plugins = selectPlugins(args);
  if (plugins.length === 0) {
    listAvailable();
    return;
  }

  console.log(
    chalk.dim(
      `Long-only signal replay · $${args.amount}/entry · Yahoo daily · classes: ${args.classes.join(' + ')} · ignores fees/slippage`,
    ),
  );

  for (const plugin of plugins) {
    console.log(`\n${chalk.bold('▶ ' + (plugin.manifest.name ?? plugin.manifest.id))} ${chalk.dim('(' + plugin.manifest.id + ')')}`);
    const results: ClassResult[] = [];
    for (const assetClass of args.classes) {
      const r = await backtestClass(plugin, assetClass, args.amount);
      results.push(r);
      renderClass(r);
    }
    if (args.classes.length > 1) renderVerdict(results);
  }
}
