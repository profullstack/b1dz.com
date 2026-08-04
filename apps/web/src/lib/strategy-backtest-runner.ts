/**
 * Server-side strategy backtest runner for the builder wizard.
 *
 * Replays a compiled StrategyPlugin long-only over daily closes for a chosen
 * TIME FRAME, scoring crypto and equities SEPARATELY. Uses a BANKROLL model:
 * the bankroll is split equally across the basket, and each slice compounds
 * through that symbol's round-trips (cash → shares → cash). Pure — the price
 * fetch is injected so the route supplies a source and tests supply a stub.
 *
 * COSTS. This wizard feeds the store, so a number shown here is a number a
 * stranger may risk money on. Every slice therefore compounds by the trade's
 * `netMultiple` (cash out / cash in, net of fees, spread and slippage) rather
 * than by the raw price ratio: the price ratio only carries spread + slippage
 * now, so using it silently refunds every fee. We replay each series TWICE —
 * once with the real model and once with `ZERO_COST_MODEL` — so the response can
 * put net return next to the frictionless number it would have advertised.
 * `grossReturnPct − returnPct === costDragPct`, exactly, by construction.
 *
 * The cost model is passed EXPLICITLY rather than inferred from the snapshots:
 * daily closes are synthesized with `bid === ask === close`, and the injected
 * fetcher — not this module — decides which venue the data came from, so there
 * is no venue here worth trusting. Judgement calls in `DEFAULT_CLASS_COSTS`.
 */
import type { StrategyPlugin, MarketSnapshot } from '@b1dz/core';
import {
  replayStrategy,
  roundTripCostBps,
  DEFAULT_COST_MODEL,
  EQUITY_COST_MODEL,
  ZERO_COST_MODEL,
  type CostModel,
} from '@b1dz/source-strategies';

export type AssetClass = 'crypto' | 'equity';

export const CRYPTO_BASKET = ['BTC-USD', 'ETH-USD', 'SOL-USD'];
export const EQUITY_BASKET = ['SPY', 'AAPL', 'NVDA'];
const MIN_BARS = 35; // enough for the slowest indicator (MACD/trend)

/**
 * Default friction per asset class.
 *
 * Crypto gets `DEFAULT_COST_MODEL` (Coinbase-tier, 60 bps/leg) and not the
 * cheaper Kraken schedule the crypto fetcher happens to read closes from: the
 * user picks their own venue, and a strategy that only clears the hurdle at the
 * cheapest venue we know of is not a strategy we should be advertising.
 * Equities get `EQUITY_COST_MODEL` — commission-free everywhere b1dz connects,
 * so spread plus impact is the whole cost.
 */
export const DEFAULT_CLASS_COSTS: Record<AssetClass, CostModel> = {
  crypto: DEFAULT_COST_MODEL,
  equity: EQUITY_COST_MODEL,
};

/** Venue id stamped on synthesized snapshots — deliberately not a real venue. */
const SYNTHETIC_VENUE: Record<AssetClass, string> = {
  crypto: 'backtest-crypto',
  equity: 'backtest-equity',
};

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

/** The cost assumptions a result was scored under, flattened for the wire/UI. */
export interface CostAssumptions {
  feeBps: number;
  slippageBps: number;
  assumedHalfSpreadBps: number;
  perOrderUsd: number;
  /** Break-even move a round trip must clear under these assumptions. */
  roundTripBps: number;
}

export interface ClassResult {
  assetClass: AssetClass;
  basket: string[];
  symbols: string[]; // ones that returned usable data
  trades: number;
  returnPct: number; // NET of modelled costs
  /** What the same trades would have returned frictionless. The honesty delta. */
  grossReturnPct: number;
  winRate: number; // counted on NET profit
  profit: number; // finalEquity - bankroll, net
  maxDrawdown: number; // dollars, peak-to-trough on the merged equity curve
  bankroll: number;
  finalEquity: number;
  feesUsd: number;
  spreadSlippageUsd: number;
  totalCostUsd: number;
  /** totalCostUsd / bankroll — equals grossReturnPct − returnPct. */
  costDragPct: number;
  costs: CostAssumptions;
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
  const exchange = SYNTHETIC_VENUE[assetClass];
  return rows
    .filter((r) => Number.isFinite(r.close))
    .sort((a, b) => a.ts - b.ts)
    .map((r) => ({ exchange, pair: symbol, bid: r.close, ask: r.close, bidSize: 1, askSize: 1, ts: r.ts, assetClass }));
}

export function costAssumptions(costs: CostModel, notionalUsd: number): CostAssumptions {
  return {
    feeBps: costs.feeBps,
    slippageBps: costs.slippageBps,
    assumedHalfSpreadBps: costs.assumedHalfSpreadBps,
    perOrderUsd: costs.perOrderUsd,
    roundTripBps: roundTripCostBps(costs, notionalUsd),
  };
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
  costs: CostModel,
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
  const slice = symbols.length > 0 ? bankroll / symbols.length : bankroll;
  const result: ClassResult = {
    assetClass,
    basket,
    symbols,
    trades: 0,
    returnPct: 0,
    grossReturnPct: 0,
    winRate: 0,
    profit: 0,
    maxDrawdown: 0,
    bankroll,
    finalEquity: bankroll,
    feesUsd: 0,
    spreadSlippageUsd: 0,
    totalCostUsd: 0,
    costDragPct: 0,
    costs: costAssumptions(costs, slice),
  };
  if (symbols.length === 0) return result;

  const events: EquityEvent[] = [];
  let netFinal = 0;
  let grossFinal = 0;
  let wins = 0;
  let tradeCount = 0;
  // Per-trade friction at the replay notional. Only its fee/spread RATIO is used
  // — the dollar total comes from the two equity curves, which is compounding-aware.
  let rawFees = 0;
  let rawSpread = 0;

  for (const [symbol, snaps] of series) {
    const trades = replayStrategy(plugin, snaps, { amountPerEntry: slice, costs });
    let equity = slice;
    events.push({ ts: startMs, symbol, equity });
    for (const t of trades) {
      tradeCount++;
      if (t.netMultiple > 1) wins++; // a fee-eating "winner" is a loss
      rawFees += t.feesUsd;
      rawSpread += t.spreadSlippageUsd;
      equity *= t.netMultiple; // compound the slice through this round-trip
      events.push({ ts: t.exitTs, symbol, equity });
    }
    netFinal += equity;

    // Same signals, same bars, no friction — what the strategy would have "made".
    let gross = slice;
    for (const t of replayStrategy(plugin, snaps, { amountPerEntry: slice, costs: ZERO_COST_MODEL })) {
      gross *= t.netMultiple;
    }
    grossFinal += gross;
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

  const totalCostUsd = Math.max(0, grossFinal - netFinal);
  const rawTotal = rawFees + rawSpread;
  const feesUsd = rawTotal > 0 ? (totalCostUsd * rawFees) / rawTotal : 0;

  result.trades = tradeCount;
  result.finalEquity = netFinal;
  result.profit = netFinal - bankroll;
  result.returnPct = bankroll > 0 ? netFinal / bankroll - 1 : 0;
  result.grossReturnPct = bankroll > 0 ? grossFinal / bankroll - 1 : 0;
  result.winRate = tradeCount ? wins / tradeCount : 0;
  result.maxDrawdown = maxDrawdown;
  result.feesUsd = feesUsd;
  result.spreadSlippageUsd = totalCostUsd - feesUsd;
  result.totalCostUsd = totalCostUsd;
  result.costDragPct = bankroll > 0 ? totalCostUsd / bankroll : 0;
  return result;
}

export async function runStrategyBacktest(
  plugin: StrategyPlugin,
  opts: {
    classes: AssetClass[];
    bankroll: number;
    timeframe: TimeframeLabel;
    fetchCloses: FetchCloses;
    /** Override the per-asset-class default friction (route body, CLI flag, tests). */
    costs?: CostModel;
  },
): Promise<BacktestResponse> {
  const tf = TIMEFRAMES.find((t) => t.label === opts.timeframe) ?? TIMEFRAMES.find((t) => t.label === DEFAULT_TIMEFRAME)!;
  const now = new Date();
  const endMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const startMs = windowStart(now, tf).getTime();

  const classes: ClassResult[] = [];
  for (const assetClass of opts.classes) {
    const costs = opts.costs ?? DEFAULT_CLASS_COSTS[assetClass];
    classes.push(await backtestClass(plugin, assetClass, opts.bankroll, costs, startMs, endMs, opts.fetchCloses));
  }

  let verdict: BacktestResponse['verdict'] = null;
  const scored = classes.filter((c) => c.trades > 0);
  if (scored.length >= 2) {
    const ranked = [...scored].sort((a, b) => b.returnPct - a.returnPct);
    verdict = { winner: ranked[0]!.assetClass, classes: ranked.map((c) => ({ assetClass: c.assetClass, returnPct: c.returnPct })) };
  }

  return { bankroll: opts.bankroll, timeframe: tf.label, startYmd: ymd(new Date(startMs)), endYmd: ymd(new Date(endMs)), classes, verdict };
}
