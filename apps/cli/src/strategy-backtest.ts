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
 * Every number here is NET of a real cost model — fees on both legs, the assumed
 * spread (Yahoo daily closes have none of their own), and slippage. Each horizon
 * is therefore replayed twice, once priced and once with ZERO_COST_MODEL, so the
 * `Gross` column shows exactly what the friction took. Venue matters more than
 * most people expect: the same strategy can print +12% on Binance.US and −4% on
 * Coinbase, which is why `--costs <venue>` exists.
 *
 *   b1dz strategy-backtest mean-reversion          # both classes, compared
 *   b1dz strategy-backtest all --crypto            # every built-in, crypto only
 *   b1dz strategy-backtest --equities --file my.tsp.json
 *   b1dz strategy-backtest trend-continuation --amount 250
 *   b1dz strategy-backtest breakout --costs kraken
 *   b1dz strategy-backtest breakout --fee-bps 10 --slippage-bps 2 --spread-bps 1
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
  costModelFor,
  describeCostModel,
  DEFAULT_COST_MODEL,
  DEX_COST_MODEL,
  EQUITY_COST_MODEL,
  ZERO_COST_MODEL,
  type BacktestSummary,
  type CostModel,
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

/**
 * Named cost models, keyed by how a user thinks about the decision ("what does
 * this look like on Kraken?"). `zero` is the old frictionless behaviour and is
 * kept only for diffing against a priced run — never for judging a strategy.
 */
const COST_PRESETS = {
  zero: ZERO_COST_MODEL,
  kraken: costModelFor({ assetClass: 'crypto', exchange: 'kraken' }),
  coinbase: costModelFor({ assetClass: 'crypto', exchange: 'coinbase' }),
  gemini: costModelFor({ assetClass: 'crypto', exchange: 'gemini' }),
  'binance-us': costModelFor({ assetClass: 'crypto', exchange: 'binance-us' }),
  equity: EQUITY_COST_MODEL,
  dex: DEX_COST_MODEL,
} satisfies Record<string, CostModel>;

export type CostPreset = keyof typeof COST_PRESETS;
export const COST_PRESETS_NAMES = Object.keys(COST_PRESETS) as CostPreset[];

interface HorizonResult {
  label: string;
  startYmd: string;
  endYmd: string;
  /** Priced under the resolved cost model. */
  summary: BacktestSummary;
  /** Identical signals replayed with ZERO_COST_MODEL — the frictionless twin. */
  gross: BacktestSummary;
}

interface ClassResult {
  assetClass: AssetClass;
  basket: string[];
  symbolsWithData: string[];
  costs: CostModel;
  horizons: HorizonResult[];
  /** Longest available horizon's summary — the headline used for the verdict. */
  headline: HorizonResult | null;
}

// ── args ─────────────────────────────────────────────────────────────────────
interface Args {
  selector: string | null; // strategy id, 'all', or null
  file: string | null;
  classes: AssetClass[];
  amount: number;
  /** null → per-asset-class defaults rather than one model for everything. */
  costPreset: CostPreset | null;
  /** Field-level overrides layered on top of the preset/default. */
  costOverrides: Partial<CostModel>;
}

/** A non-negative numeric flag, or undefined when absent. Throws on garbage. */
function bpsFlag(flags: Record<string, string>, key: string): number | undefined {
  const raw = flags[key];
  if (raw === undefined) return undefined;
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`invalid --${key} "${raw}" — expected a non-negative number`);
  return n;
}

/**
 * Resolve the model a class is scored under. A preset applies to every class
 * (you asked for Kraken, you get Kraken); without one, each class gets its own
 * realistic default, since equities are commission-free and crypto is not.
 */
export function resolveCostModel(args: Args, assetClass: AssetClass): CostModel {
  const base = args.costPreset
    ? COST_PRESETS[args.costPreset]
    : assetClass === 'crypto'
      ? DEFAULT_COST_MODEL
      : EQUITY_COST_MODEL;
  return { ...base, ...args.costOverrides };
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

  let costPreset: CostPreset | null = null;
  if (flags.costs !== undefined) {
    const wanted = flags.costs.toLowerCase();
    if (!(COST_PRESETS_NAMES as string[]).includes(wanted)) {
      throw new Error(`invalid --costs "${flags.costs}" — expected one of ${COST_PRESETS_NAMES.join(', ')}`);
    }
    costPreset = wanted as CostPreset;
  }

  // --spread-bps is the assumed HALF-spread: entry pays +half, exit pays −half,
  // so a round trip costs the full spread. Same convention as CostModel.
  const costOverrides: Partial<CostModel> = {};
  const feeBps = bpsFlag(flags, 'fee-bps');
  if (feeBps !== undefined) costOverrides.feeBps = feeBps;
  const slippageBps = bpsFlag(flags, 'slippage-bps');
  if (slippageBps !== undefined) costOverrides.slippageBps = slippageBps;
  const spreadBps = bpsFlag(flags, 'spread-bps');
  if (spreadBps !== undefined) costOverrides.assumedHalfSpreadBps = spreadBps;

  return {
    selector: positional[0] ?? (flags.strategy ?? null),
    file: flags.file ?? null,
    classes,
    amount,
    costPreset,
    costOverrides,
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

async function backtestClass(
  plugin: StrategyPlugin,
  assetClass: AssetClass,
  amount: number,
  costs: CostModel,
): Promise<ClassResult> {
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

  const horizons: HorizonResult[] = HORIZONS.map((h) => {
    const hStart = subtract(now, h).getTime();
    const windows = [...series.values()]
      .map((snaps) => snaps.filter((s) => s.ts >= hStart))
      .filter((w) => w.length >= MIN_BARS);
    const priced = windows.flatMap((w) => replayStrategy(plugin, w, { amountPerEntry: amount, costs }));
    const free = windows.flatMap((w) => replayStrategy(plugin, w, { amountPerEntry: amount, costs: ZERO_COST_MODEL }));
    return {
      label: h.label,
      startYmd: ymd(new Date(hStart)),
      endYmd: ymd(new Date(endMs)),
      summary: summarizeTrades(priced),
      gross: summarizeTrades(free),
    };
  });

  return {
    assetClass,
    basket,
    symbolsWithData: [...series.keys()],
    costs,
    horizons,
    headline: [...horizons].reverse().find((h) => h.summary.trades > 0) ?? null,
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
/** A cost is never a gain, so it gets no sign — just a magnitude. */
function fmtCost(n: number): string {
  return `$${n.toFixed(2)}`;
}

function renderClass(r: ClassResult, amount: number): void {
  const label = r.assetClass === 'crypto' ? 'CRYPTO' : 'EQUITIES';
  console.log(`\n${chalk.bold.cyan(label)}  ${chalk.dim(r.symbolsWithData.join(', ') || '(no data)')}`);
  console.log(chalk.dim(`  costs: ${describeCostModel(r.costs, amount)}`));
  const table = new Table({
    head: ['Horizon', 'Trades', 'Win%', 'Return', 'Gross', 'Fees', 'Profit', 'MaxDD'].map((h) => chalk.dim(h)),
    style: { head: [], border: [] },
    colAligns: ['left', 'right', 'right', 'right', 'right', 'right', 'right', 'right'],
  });
  for (const h of r.horizons) {
    const s = h.summary;
    table.push([
      h.label,
      String(s.trades),
      `${Math.round(s.winRate * 100)}%`,
      fmtPct(s.returnPct),
      chalk.dim(fmtPct(h.gross.returnPct)),
      chalk.dim(fmtCost(s.feesUsd)),
      fmtUsd(s.profit),
      `$${s.maxDrawdown.toFixed(0)}`,
    ]);
  }
  console.log(table.toString());

  const hl = r.headline;
  if (hl && hl.summary.trades > 0) {
    console.log(
      chalk.dim(
        `  drag over ${hl.label}: ${fmtCost(hl.summary.feesUsd)} fees + ` +
          `${fmtCost(hl.summary.spreadSlippageUsd)} spread/slippage ` +
          `(${(hl.summary.costDragPct * 100).toFixed(2)}% of capital deployed)`,
      ),
    );
  }
}

function renderVerdict(results: ClassResult[]): void {
  const withHeadline = results.filter((r) => r.headline);
  if (withHeadline.length < 2) return;
  const [a, b] = [...withHeadline].sort((x, y) => y.headline!.summary.returnPct - x.headline!.summary.returnPct);
  const winner = a!.assetClass === 'crypto' ? 'crypto' : 'equities';
  const ra = a!.headline!;
  const rb = b!.headline!;
  console.log(`\n${chalk.bold('Head-to-head')} (best common window, net of costs):`);
  console.log(
    `  ${chalk.cyan(a!.assetClass.padEnd(7))} ${fmtPct(ra.summary.returnPct)} over ${ra.label} ` +
      `(${Math.round(ra.summary.winRate * 100)}% win, ${ra.summary.trades} trades, ${chalk.dim(`gross ${fmtPct(ra.gross.returnPct)}`)})`,
  );
  console.log(
    `  ${chalk.cyan(b!.assetClass.padEnd(7))} ${fmtPct(rb.summary.returnPct)} over ${rb.label} ` +
      `(${Math.round(rb.summary.winRate * 100)}% win, ${rb.summary.trades} trades, ${chalk.dim(`gross ${fmtPct(rb.gross.returnPct)}`)})`,
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

  // lgtm[js/sql-injection] — CLI output string, not SQL
  if (args.costPreset) {
    console.log(chalk.dim(`Long-only signal replay · $${args.amount}/entry · Yahoo daily · classes: ${args.classes.join(' + ')} · costs: ${args.costPreset}`));
  } else {
    console.log(chalk.dim(`Long-only signal replay · $${args.amount}/entry · Yahoo daily · classes: ${args.classes.join(' + ')} · costs: per-class defaults`));
  }

  for (const plugin of plugins) {
    console.log(`\n${chalk.bold('▶ ' + (plugin.manifest.name ?? plugin.manifest.id))} ${chalk.dim('(' + plugin.manifest.id + ')')}`);
    const results: ClassResult[] = [];
    for (const assetClass of args.classes) {
      const costs = resolveCostModel(args, assetClass);
      const r = await backtestClass(plugin, assetClass, args.amount, costs);
      results.push(r);
      renderClass(r, args.amount);
    }
    if (args.classes.length > 1) renderVerdict(results);
  }
}
