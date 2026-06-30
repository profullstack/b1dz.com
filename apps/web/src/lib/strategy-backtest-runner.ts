/**
 * Server-side strategy backtest runner for the builder wizard.
 *
 * Replays a compiled StrategyPlugin long-only over daily closes for a chosen
 * TIME FRAME, scoring crypto and equities SEPARATELY. Uses a BANKROLL model:
 * the bankroll is split equally across the basket, and each slice compounds
 * through that symbol's round-trips (cash → shares → cash). Pure — the price
 * fetch is injected so the route supplies a source and tests supply a stub.
 */
import type { StrategyPlugin, MarketSnapshot } from '@b1dz/core';
import { replayStrategy } from '@b1dz/source-strategies';

export type AssetClass = 'crypto' | 'equity';

export const CRYPTO_BASKET = ['BTC-USD', 'ETH-USD', 'SOL-USD'];
export const EQUITY_BASKET = ['SPY', 'AAPL', 'NVDA'];
const MIN_BARS = 35; // enough for the slowest indicator (MACD/trend)

export const TIMEFRAMES = [
  { label: '1 month', months: 1 },
  { label: '3 months', months: 3 },
  { label: '6 months', months: 6 },
  { label: '1 year', years: 1 },
  { label: '2 years', years: 2 },
  { label: '5 years', years: 5 },
] as const;

export type TimeframeLabel = (typeof TIMEFRAMES)[number]['label'];
export const DEFAULT_TIMEFRAME: TimeframeLabel = '1 year';

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
  trades: number;
  returnPct: number;
  winRate: number;
  profit: number; // finalEquity - bankroll
  maxDrawdown: number; // dollars, peak-to-trough on the merged equity curve
  bankroll: number;
  finalEquity: number;
}

export interface BacktestResponse {
  bankroll: number;
  timeframe: TimeframeLabel;
  startYmd: string;
  endYmd: string;
  classes: ClassResult[];
  verdict: { winner: AssetClass; classes: { assetClass: AssetClass; returnPct: number }[] } | null;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}
function ymd(d: Date): string {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}
function windowStart(end: Date, tf: (typeof TIMEFRAMES)[number]): Date {
  const d = new Date(end);
  if ('months' in tf) d.setUTCMonth(d.getUTCMonth() - tf.months);
  else d.setUTCFullYear(d.getUTCFullYear() - tf.years);
  return d;
}

function toSnapshots(symbol: string, rows: DailyClose[], assetClass: AssetClass): MarketSnapshot[] {
  return rows
    .filter((r) => Number.isFinite(r.close))
    .sort((a, b) => a.ts - b.ts)
    .map((r) => ({ exchange: 'src', pair: symbol, bid: r.close, ask: r.close, bidSize: 1, askSize: 1, ts: r.ts, assetClass }));
}

/** An equity event: this symbol's slice is now worth `equity` as of `ts`. */
interface EquityEvent {
  ts: number;
  symbol: string;
  equity: number;
}

async function backtestClass(
  plugin: StrategyPlugin,
  assetClass: AssetClass,
  bankroll: number,
  tf: (typeof TIMEFRAMES)[number],
  startMs: number,
  endMs: number,
  fetchCloses: FetchCloses,
): Promise<ClassResult> {
  const basket = assetClass === 'crypto' ? CRYPTO_BASKET : EQUITY_BASKET;

  const series = new Map<string, MarketSnapshot[]>();
  for (const symbol of basket) {
    try {
      const rows = await fetchCloses(symbol, startMs, endMs);
      const snaps = toSnapshots(symbol, rows, assetClass).filter((s) => s.ts >= startMs);
      if (snaps.length >= MIN_BARS) series.set(symbol, snaps);
    } catch {
      // a single bad symbol shouldn't sink the class
    }
  }

  const symbols = [...series.keys()];
  const result: ClassResult = {
    assetClass,
    basket,
    symbols,
    trades: 0,
    returnPct: 0,
    winRate: 0,
    profit: 0,
    maxDrawdown: 0,
    bankroll,
    finalEquity: bankroll,
  };
  if (symbols.length === 0) return result;

  const slice = bankroll / symbols.length;
  const events: EquityEvent[] = [];
  let totalFinal = 0;
  let wins = 0;
  let tradeCount = 0;

  for (const [symbol, snaps] of series) {
    const trades = replayStrategy(plugin, snaps, 1); // amount irrelevant — we use price ratios
    let equity = slice;
    events.push({ ts: startMs, symbol, equity });
    for (const t of trades) {
      tradeCount++;
      if (t.exitPrice > t.entryPrice) wins++;
      equity *= t.exitPrice / t.entryPrice; // compound the slice through this round-trip
      events.push({ ts: t.exitTs, symbol, equity });
    }
    totalFinal += equity;
  }

  // Merged equity curve → peak-to-trough drawdown in dollars.
  events.sort((a, b) => a.ts - b.ts);
  const cur = new Map<string, number>(symbols.map((s) => [s, slice]));
  let peak = bankroll;
  let maxDrawdown = 0;
  for (const e of events) {
    cur.set(e.symbol, e.equity);
    let total = 0;
    for (const v of cur.values()) total += v;
    peak = Math.max(peak, total);
    maxDrawdown = Math.max(maxDrawdown, peak - total);
  }

  result.trades = tradeCount;
  result.finalEquity = totalFinal;
  result.profit = totalFinal - bankroll;
  result.returnPct = bankroll > 0 ? totalFinal / bankroll - 1 : 0;
  result.winRate = tradeCount ? wins / tradeCount : 0;
  result.maxDrawdown = maxDrawdown;
  return result;
}

export async function runStrategyBacktest(
  plugin: StrategyPlugin,
  opts: { classes: AssetClass[]; bankroll: number; timeframe: TimeframeLabel; fetchCloses: FetchCloses },
): Promise<BacktestResponse> {
  const tf = TIMEFRAMES.find((t) => t.label === opts.timeframe) ?? TIMEFRAMES.find((t) => t.label === DEFAULT_TIMEFRAME)!;
  const now = new Date();
  const endMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const startMs = windowStart(now, tf).getTime();

  const classes: ClassResult[] = [];
  for (const assetClass of opts.classes) {
    classes.push(await backtestClass(plugin, assetClass, opts.bankroll, tf, startMs, endMs, opts.fetchCloses));
  }

  let verdict: BacktestResponse['verdict'] = null;
  const scored = classes.filter((c) => c.trades > 0);
  if (scored.length >= 2) {
    const ranked = [...scored].sort((a, b) => b.returnPct - a.returnPct);
    verdict = { winner: ranked[0]!.assetClass, classes: ranked.map((c) => ({ assetClass: c.assetClass, returnPct: c.returnPct })) };
  }

  return { bankroll: opts.bankroll, timeframe: tf.label, startYmd: ymd(new Date(startMs)), endYmd: ymd(new Date(endMs)), classes, verdict };
}
