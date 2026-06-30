/**
 * Server-side strategy backtest runner for the builder wizard.
 *
 * Replays a compiled StrategyPlugin (built-in or compiled from a user's TSP doc)
 * long-only over daily closes, scoring crypto and equities SEPARATELY across the
 * same horizons the store cards use. Pure: the price fetch is injected so the
 * route supplies Yahoo and tests supply a stub.
 */
import type { StrategyPlugin, MarketSnapshot } from '@b1dz/core';
import { replayStrategy, summarizeTrades } from '@b1dz/source-strategies';
import type { BacktestHorizon } from './strategy-backtest-display';

export type AssetClass = 'crypto' | 'equity';

export const CRYPTO_BASKET = ['BTC-USD', 'ETH-USD', 'SOL-USD'];
export const EQUITY_BASKET = ['SPY', 'AAPL', 'NVDA'];
const MIN_BARS = 35; // enough for the slowest indicator (MACD/trend)

const HORIZONS = [
  { label: '1 month', months: 1 },
  { label: '3 months', months: 3 },
  { label: '6 months', months: 6 },
  { label: '1 year', years: 1 },
  { label: '2 years', years: 2 },
  { label: '5 years', years: 5 },
] as const;

export interface DailyClose {
  ts: number;
  close: number;
}

/** Fetch daily closes for a symbol within [startMs, endMs]. */
export type FetchCloses = (symbol: string, startMs: number, endMs: number) => Promise<DailyClose[]>;

export interface ClassResult {
  assetClass: AssetClass;
  basket: string[];
  symbols: string[]; // ones that returned usable data
  horizons: BacktestHorizon[];
  /** Longest window that produced trades — the headline used for the verdict. */
  headline: BacktestHorizon | null;
}

export interface BacktestResponse {
  amount: number;
  classes: ClassResult[];
  verdict: { winner: AssetClass; classes: { assetClass: AssetClass; label: string; returnPct: number }[] } | null;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}
function ymd(d: Date): string {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}
function horizonStart(end: Date, h: (typeof HORIZONS)[number]): Date {
  const d = new Date(end);
  if ('months' in h) d.setUTCMonth(d.getUTCMonth() - h.months);
  else d.setUTCFullYear(d.getUTCFullYear() - h.years);
  return d;
}

function toSnapshots(symbol: string, rows: DailyClose[], assetClass: AssetClass): MarketSnapshot[] {
  return rows
    .filter((r) => Number.isFinite(r.close))
    .sort((a, b) => a.ts - b.ts)
    .map((r) => ({ exchange: 'yahoo', pair: symbol, bid: r.close, ask: r.close, bidSize: 1, askSize: 1, ts: r.ts, assetClass }));
}

async function backtestClass(
  plugin: StrategyPlugin,
  assetClass: AssetClass,
  amount: number,
  fetchCloses: FetchCloses,
): Promise<ClassResult> {
  const basket = assetClass === 'crypto' ? CRYPTO_BASKET : EQUITY_BASKET;
  const now = new Date();
  const endMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const startMs = horizonStart(now, HORIZONS[HORIZONS.length - 1]!).getTime();

  const series = new Map<string, MarketSnapshot[]>();
  for (const symbol of basket) {
    try {
      const rows = await fetchCloses(symbol, startMs, endMs);
      if (rows.length) series.set(symbol, toSnapshots(symbol, rows, assetClass));
    } catch {
      // a single bad symbol shouldn't sink the class
    }
  }

  const horizons: BacktestHorizon[] = HORIZONS.map((h) => {
    const hStart = horizonStart(now, h).getTime();
    const trades = [...series.values()].flatMap((snaps) => {
      const window = snaps.filter((s) => s.ts >= hStart);
      return window.length < MIN_BARS ? [] : replayStrategy(plugin, window, amount);
    });
    const s = summarizeTrades(trades);
    return {
      label: h.label,
      startYmd: ymd(new Date(hStart)),
      endYmd: ymd(new Date(endMs)),
      trades: s.trades,
      returnPct: s.returnPct,
      winRate: s.winRate,
      profit: s.profit,
      maxDrawdown: s.maxDrawdown,
    };
  });

  const headline = [...horizons].reverse().find((h) => h.trades > 0) ?? null;
  return { assetClass, basket, symbols: [...series.keys()], horizons, headline };
}

export async function runStrategyBacktest(
  plugin: StrategyPlugin,
  opts: { classes: AssetClass[]; amount: number; fetchCloses: FetchCloses },
): Promise<BacktestResponse> {
  const classes: ClassResult[] = [];
  for (const assetClass of opts.classes) {
    classes.push(await backtestClass(plugin, assetClass, opts.amount, opts.fetchCloses));
  }

  let verdict: BacktestResponse['verdict'] = null;
  const scored = classes.filter((c) => c.headline);
  if (scored.length >= 2) {
    const ranked = [...scored].sort((a, b) => b.headline!.returnPct - a.headline!.returnPct);
    verdict = {
      winner: ranked[0]!.assetClass,
      classes: ranked.map((c) => ({ assetClass: c.assetClass, label: c.headline!.label, returnPct: c.headline!.returnPct })),
    };
  }

  return { amount: opts.amount, classes, verdict };
}
