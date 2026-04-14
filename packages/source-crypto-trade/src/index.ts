/**
 * Crypto day-trading source — single-exchange strategies on Kraken.
 *
 *   poll()      → snapshot configured pairs from Kraken
 *   evaluate()  → run multi-signal strategy; emit Opportunity on confirmed signals
 *   act()       → place order on Kraken, only if profitable after fees
 *
 * Risk management:
 *   - Trailing stop-loss (breakeven → lock-in profit)
 *   - Take-profit at +1.5%
 *   - 10-minute cooldown between trades per pair
 *   - 5%/day max realized loss limit across total account equity
 *   - $100 max position size
 */

import type { Source, MarketSnapshot, Opportunity, ActionResult, PriceFeed } from '@b1dz/core';
import {
  KrakenFeed, CoinbaseFeed, BinanceUsFeed,
  placeOrder as placeKrakenOrder,
  placeCoinbaseOrder,
  placeBinanceOrder,
  getBalance as getKrakenBalance,
  getOpenOrders as getKrakenOpenOrders,
  cancelKrakenOrder,
  getCoinbaseBalance,
  getCoinbaseAvailableBalance,
  getBinanceBalance,
  getCoinbaseFills,
  getBinanceTrades,
  getBinanceTradingRules,
  hasBinanceTradingSymbol,
  hasCoinbaseTradingProduct,
  hasKrakenTradingPair,
  getKrakenPairMinVolume,
  MAX_POSITION_USD, KRAKEN_TAKER_FEE, COINBASE_TAKER_FEE, BINANCE_TAKER_FEE,
  getActivePairs,
} from '@b1dz/source-crypto-arb';
import type { Candle } from './analysis/candles.js';
import { DEFAULT_ANALYSIS_CONFIG } from './analysis/config.js';
import { applySnapshotToCandles, fetchHistoricalCandles } from './analysis/candles.js';
import { analyzeSignal, type AnalysisSignal } from './analysis/engine.js';
import {
  publishEntrySignal,
  publishExitSignal,
  publishLiquidationSignal,
} from './analysis/signalPublisher.js';

export interface Signal {
  side: 'buy' | 'sell';
  /** 0..1 strength */
  strength: number;
  reason: string;
}

export interface Strategy {
  id: string;
  evaluate(snap: MarketSnapshot, history: MarketSnapshot[]): Signal | null;
}

/** Placeholder momentum strategy — kept for reference/testing. */
export const momentumStrategy: Strategy = {
  id: 'momentum',
  evaluate(snap, history) {
    if (history.length < 3) return null;
    const recent = history.slice(-3);
    const rising = recent.every((s, i, a) => i === 0 || s.bid > a[i - 1].bid);
    if (!rising) return null;
    return { side: 'buy', strength: 0.7, reason: '3 rising ticks' };
  },
};

interface TradeItem {
  pair: string;
  exchange: string;
  snap: MarketSnapshot;
  history: MarketSnapshot[];
  analysis: AnalysisSignal | null;
}

// ─── Exit parameters ───────────────────────────────────────────

/** Take-profit target. */
const TAKE_PROFIT_PCT = 0.008;  // +0.8% (lowered from 1.5% — more achievable)

/** Initial stop-loss. */
const INITIAL_STOP_PCT = 0.004; // -0.4%

/** Move stop to breakeven when position reaches this profit. */
const BREAKEVEN_TRIGGER_PCT = 0.003; // +0.3%

/** Lock in profit: move stop to this level when position reaches LOCK_TRIGGER. */
const LOCK_TRIGGER_PCT = 0.005;  // +0.5%
const LOCK_STOP_PCT = 0.002;     // stop at +0.2% (lock in small profit)

/** Close at market if position has been open this long and is flat. */
const TIME_EXIT_MS = 15 * 60 * 1000; // 15 minutes (was 30)
const TIME_EXIT_FLAT_PCT = 0.001; // ±0.1%

/** Cooldown after closing a position before opening another. */
const COOLDOWN_MS = 3 * 60 * 1000; // 3 minutes (was 10)

/** Max daily realized loss before halting new entries, as % of start-of-day total equity. */
const DAILY_LOSS_LIMIT_PCT = (() => {
  const value = Number.parseFloat(process.env.DAILY_LOSS_LIMIT_PCT ?? '5');
  return Number.isFinite(value) && value > 0 ? value : 5;
})();
const WARMUP_TICKS = 20;

// ─── State ─────────────────────────────────────────────────────

// Pairs are discovered dynamically — top volume pairs across exchanges
const krakenFeed: PriceFeed = new KrakenFeed();
const coinbaseFeed: PriceFeed = new CoinbaseFeed();
const binanceFeed: PriceFeed = new BinanceUsFeed();
const TRADE_FEEDS: { feed: PriceFeed; exchange: string }[] = [
  { feed: krakenFeed, exchange: 'kraken' },
  { feed: coinbaseFeed, exchange: 'coinbase' },
  { feed: binanceFeed, exchange: 'binance-us' },
];
const histories = new Map<string, MarketSnapshot[]>();
interface AnalysisPairState {
  entryCandles: Candle[];
  confirmCandles: Candle[];
  biasCandles: Candle[];
  pendingSnapshots: MarketSnapshot[];
  bootstrapPromise: Promise<void> | null;
  bootstrapped: boolean;
  lastAnalysis: AnalysisSignal | null;
  lastLogAt: number;
}
const analysisStates = new Map<string, AnalysisPairState>();
const ANALYSIS_ENTRY_LIMIT = 220;
const ANALYSIS_CONFIRM_LIMIT = 220;
const ANALYSIS_BIAS_LIMIT = 180;

interface Position {
  pair: string;
  exchange: string;
  entryPrice: number;
  volume: number;
  entryTime: number;
  highWaterMark: number; // highest price seen since entry
  strategyId?: string;
}
const openPositions = new Map<string, Position>();
interface PendingLiquidation {
  exchange: string;
  pair: string;
  volume: number;
  discoveredAt: number;
}
const pendingLiquidations = new Map<string, PendingLiquidation>();

export interface ClosedTrade {
  exchange: string;
  pair: string;
  strategyId: string;
  entryPrice: number;
  exitPrice: number;
  volume: number;
  entryTime: number;
  exitTime: number;
  grossPnl: number;
  fee: number;
  netPnl: number;
}

const closedTrades: ClosedTrade[] = [];
let restoredTradeState = false;

/** One position per exchange — check if THIS exchange already has a position. */
function hasPositionOnExchange(exchange: string): boolean {
  for (const pos of openPositions.values()) {
    if (pos.exchange === exchange) return true;
  }
  return false;
}

/** Pending buy — set in evaluate(), cleared at the next poll. Prevents multiple buys in one scan pass. */
let pendingBuyExchange: string | null = null;
const attemptedExchangeActions = new Set<string>();

/** Timestamp of last trade close per pair. */
const lastExitAt = new Map<string, number>();

/** Cumulative realized P/L for today. */
let dailyPnl = 0;
let dailyPnlDate = new Date().toDateString();
let dailyEquityBaselineUsd = 0;
let tradePollCount = 0;
let lastEligiblePairs: string[] = [];
let lastQuoteBalanceRefresh = 0;
let lastDailyLossLimitLogAt = 0;

/** Whether we've hydrated from exchange APIs yet. */
const hydratedExchanges = new Set<string>();
let krakenHydrationBlockedUntil = 0;
const KRAKEN_HYDRATION_LOCKOUT_MS = 15 * 60_000;
const QUOTE_BALANCE_REFRESH_MS = 60_000;
const MIN_SPENDABLE_QUOTE_USD = 5;
const DUST_USD_THRESHOLD = 1;
const STALE_OPEN_BUY_ORDER_MS = 5 * 60_000;
const spendableQuoteBalances: Record<string, Record<string, number>> = {
  kraken: {},
  coinbase: {},
  'binance-us': {},
};
const accountBalances: Record<string, Record<string, string>> = {
  kraken: {},
  coinbase: {},
  'binance-us': {},
};
const minExecutableUsdByMarket = new Map<string, number>();

const STABLES = new Set(['ZUSD', 'USDC', 'USDT', 'USD', 'BUSD']);
const KRAKEN_ASSET_TO_PAIR: Record<string, string> = {
  XXBT: 'BTC-USD',
  XETH: 'ETH-USD',
  XZEC: 'ZEC-USD',
  XXRP: 'XRP-USD',
  XXLM: 'XLM-USD',
  XXMR: 'XMR-USD',
  XXDG: 'DOGE-USD',
};
const KRAKEN_BASE_ALIASES: Record<string, string[]> = {
  BTC: ['XXBT', 'XBT', 'BTC'],
  ETH: ['XETH', 'ETH'],
  DOGE: ['XXDG', 'XDG', 'DOGE'],
  ZEC: ['XZEC', 'ZEC'],
  XRP: ['XXRP', 'XRP'],
  XLM: ['XXLM', 'XLM'],
  XMR: ['XXMR', 'XMR'],
  LTC: ['XLTC', 'LTC'],
  ADA: ['XADA', 'ADA'],
  SOL: ['XSOL', 'SOL'],
};

function restorePosition(
  exchange: string,
  pair: string,
  volume: number,
  entryPrice: number,
  entryTime: number,
  reason: string,
) {
  openPositions.set(`${exchange}:${pair}`, {
    pair,
    exchange,
    entryPrice,
    volume,
    entryTime,
    highWaterMark: entryPrice,
  });
  pendingLiquidations.delete(`${exchange}:${pair}`);
  console.log(`[trade] RESTORED from exchange: ${exchange}:${pair} ${volume} @ $${entryPrice.toFixed(2)} (${reason})`);
}

function rememberLiquidation(exchange: string, pair: string, volume: number, reason: string) {
  const key = `${exchange}:${pair}`;
  pendingLiquidations.set(key, {
    exchange,
    pair,
    volume,
    discoveredAt: Date.now(),
  });
  console.log(`[trade] MARK LIQUIDATE ${exchange}:${pair} ${volume.toFixed(8)} (${reason})`);
}

function findNonStableHoldings(balance: Record<string, string>): { asset: string; amount: number }[] {
  const holdings: { asset: string; amount: number }[] = [];
  for (const [asset, value] of Object.entries(balance)) {
    const amount = parseFloat(value);
    if (!isFinite(amount) || amount <= 0.0001 || STABLES.has(asset)) continue;
    holdings.push({ asset, amount });
  }
  return holdings;
}

function krakenPairForAsset(asset: string): string {
  return KRAKEN_ASSET_TO_PAIR[asset] ?? `${asset}-USD`;
}

function quoteAssetForPair(pair: string): string {
  return pair.split('-')[1]?.toUpperCase() ?? 'USD';
}

function baseAssetForPair(pair: string): string {
  return pair.split('-')[0]?.toUpperCase() ?? pair;
}

function krakenQuoteBalanceKey(quoteAsset: string): string {
  switch (quoteAsset) {
    case 'USD':
      return 'ZUSD';
    default:
      return quoteAsset;
  }
}

function currentPositionOnExchange(exchange: string): Position | null {
  for (const pos of openPositions.values()) {
    if (pos.exchange === exchange) return pos;
  }
  return null;
}

function currentLiquidationOnExchange(exchange: string): PendingLiquidation | null {
  for (const liquidation of pendingLiquidations.values()) {
    if (liquidation.exchange === exchange) return liquidation;
  }
  return null;
}

function normalizeKrakenAsset(asset: string): string {
  if (asset === 'ZUSD') return 'USD';
  if (asset === 'XXBT' || asset === 'XBT') return 'BTC';
  if (asset === 'XETH') return 'ETH';
  if (asset === 'XXDG' || asset === 'XDG') return 'DOGE';
  if (asset === 'XZEC') return 'ZEC';
  if (asset === 'XXRP') return 'XRP';
  if (asset === 'XXLM') return 'XLM';
  if (asset === 'XXMR') return 'XMR';
  if (asset === 'XLTC') return 'LTC';
  if (asset === 'XADA') return 'ADA';
  if (asset === 'XSOL') return 'SOL';
  return asset.replace(/^[XZ]/, '');
}

function normalizeAssetSymbol(exchange: string, asset: string): string {
  return exchange === 'kraken' ? normalizeKrakenAsset(asset) : asset.toUpperCase();
}

function usdPriceForAsset(exchange: string, asset: string): number {
  const normalized = normalizeAssetSymbol(exchange, asset);
  if (STABLES.has(asset) || STABLES.has(normalized)) return 1;
  return latestUsdBidForPair(`${normalized}-USD`, exchange);
}

function estimateTotalEquityUsd(): number {
  let total = 0;
  for (const [exchange, balance] of Object.entries(accountBalances)) {
    for (const [asset, rawValue] of Object.entries(balance)) {
      const amount = parseFloat(rawValue);
      if (!Number.isFinite(amount) || amount <= 0) continue;
      total += amount * usdPriceForAsset(exchange, asset);
    }
  }
  return total;
}

function latestSnapshotFor(exchange: string, pair: string): MarketSnapshot | null {
  return histories.get(`${exchange}:${pair}`)?.at(-1) ?? null;
}

function latestUsdBidForPair(pair: string, preferredExchange: string): number {
  const preferred = latestSnapshotFor(preferredExchange, pair)?.bid;
  if (Number.isFinite(preferred) && preferred! > 0) return preferred!;
  for (const [key, history] of histories.entries()) {
    const [, historyPair] = key.split(':');
    if (historyPair !== pair) continue;
    const bid = history.at(-1)?.bid;
    if (Number.isFinite(bid) && bid! > 0) return bid!;
  }
  return 0;
}

function analysisStateFor(exchange: string, pair: string): AnalysisPairState {
  const key = `${exchange}:${pair}`;
  let state = analysisStates.get(key);
  if (!state) {
    state = {
      entryCandles: [],
      confirmCandles: [],
      biasCandles: [],
      pendingSnapshots: [],
      bootstrapPromise: null,
      bootstrapped: false,
      lastAnalysis: null,
      lastLogAt: 0,
    };
    analysisStates.set(key, state);
  }
  return state;
}

interface PersistedAnalysisState {
  exchange: string;
  pair: string;
  entryCandles: Candle[];
  confirmCandles: Candle[];
  biasCandles: Candle[];
  lastAnalysis: AnalysisSignal | null;
}

function serializeAnalysisStates(): PersistedAnalysisState[] {
  return [...analysisStates.entries()].map(([key, state]) => {
    const [exchange, pair] = key.split(':');
    return {
      exchange,
      pair,
      entryCandles: state.entryCandles.slice(-ANALYSIS_ENTRY_LIMIT),
      confirmCandles: state.confirmCandles.slice(-ANALYSIS_CONFIRM_LIMIT),
      biasCandles: state.biasCandles.slice(-ANALYSIS_BIAS_LIMIT),
      lastAnalysis: state.lastAnalysis,
    };
  });
}

function restoreAnalysisStates(saved: unknown): void {
  analysisStates.clear();
  if (!Array.isArray(saved)) return;
  for (const item of saved as PersistedAnalysisState[]) {
    if (!item || typeof item.exchange !== 'string' || typeof item.pair !== 'string') continue;
    analysisStates.set(`${item.exchange}:${item.pair}`, {
      entryCandles: Array.isArray(item.entryCandles) ? item.entryCandles : [],
      confirmCandles: Array.isArray(item.confirmCandles) ? item.confirmCandles : [],
      biasCandles: Array.isArray(item.biasCandles) ? item.biasCandles : [],
      pendingSnapshots: [],
      bootstrapPromise: null,
      bootstrapped: true,
      lastAnalysis: item.lastAnalysis ?? null,
      lastLogAt: 0,
    });
  }
}

async function bootstrapAnalysisState(exchange: string, pair: string, state: AnalysisPairState): Promise<void> {
  const entryTf = DEFAULT_ANALYSIS_CONFIG.timeframes.entry;
  const confirmTf = DEFAULT_ANALYSIS_CONFIG.timeframes.confirm;
  const biasTf = DEFAULT_ANALYSIS_CONFIG.timeframes.bias;
  const [entryCandles, confirmCandles, biasCandles] = await Promise.all([
    fetchHistoricalCandles(exchange, pair, entryTf, ANALYSIS_ENTRY_LIMIT),
    fetchHistoricalCandles(exchange, pair, confirmTf, ANALYSIS_CONFIRM_LIMIT),
    fetchHistoricalCandles(exchange, pair, biasTf, ANALYSIS_BIAS_LIMIT),
  ]);
  state.entryCandles = entryCandles;
  state.confirmCandles = confirmCandles;
  state.biasCandles = biasCandles;
  state.bootstrapped = true;
  const pending = [...state.pendingSnapshots];
  state.pendingSnapshots = [];
  for (const snap of pending) {
    state.entryCandles = applySnapshotToCandles(state.entryCandles, snap, entryTf, ANALYSIS_ENTRY_LIMIT);
    state.confirmCandles = applySnapshotToCandles(state.confirmCandles, snap, confirmTf, ANALYSIS_CONFIRM_LIMIT);
    state.biasCandles = applySnapshotToCandles(state.biasCandles, snap, biasTf, ANALYSIS_BIAS_LIMIT);
  }
  if (entryCandles.length === 0 && confirmCandles.length === 0 && biasCandles.length === 0) {
    console.log(`[analysis] ${exchange}:${pair} bootstrap empty`);
  }
}

function ensureAnalysisBootstrap(exchange: string, pair: string): void {
  const state = analysisStateFor(exchange, pair);
  if (state.bootstrapped || state.bootstrapPromise) return;
  state.bootstrapPromise = bootstrapAnalysisState(exchange, pair, state)
    .catch((error) => {
      console.log(`[analysis] ${exchange}:${pair} bootstrap failed: ${(error as Error).message}`);
    })
    .finally(() => {
      state.bootstrapPromise = null;
    });
}

function updateAnalysisState(exchange: string, pair: string, snap: MarketSnapshot): void {
  const state = analysisStateFor(exchange, pair);
  if (!state.bootstrapped) {
    state.pendingSnapshots.push(snap);
    while (state.pendingSnapshots.length > 500) state.pendingSnapshots.shift();
    return;
  }
  state.entryCandles = applySnapshotToCandles(state.entryCandles, snap, DEFAULT_ANALYSIS_CONFIG.timeframes.entry, ANALYSIS_ENTRY_LIMIT);
  state.confirmCandles = applySnapshotToCandles(state.confirmCandles, snap, DEFAULT_ANALYSIS_CONFIG.timeframes.confirm, ANALYSIS_CONFIRM_LIMIT);
  state.biasCandles = applySnapshotToCandles(state.biasCandles, snap, DEFAULT_ANALYSIS_CONFIG.timeframes.bias, ANALYSIS_BIAS_LIMIT);
}

function getAnalysisForItem(item: TradeItem, cooldownActive: boolean): AnalysisSignal | null {
  const state = analysisStates.get(`${item.exchange}:${item.pair}`);
  if (!state?.bootstrapped) return null;
  const analysis = analyzeSignal({
    symbol: item.pair,
    exchange: item.exchange,
    latest: item.snap,
    entryCandles: state.entryCandles,
    confirmCandles: state.confirmCandles,
    biasCandles: state.biasCandles,
    cooldownActive,
    killSwitchActive: isDailyLossLimitHit(),
  });
  state.lastAnalysis = analysis;
  const shouldLogSignal = !analysis.rejected && analysis.score >= DEFAULT_ANALYSIS_CONFIG.thresholds.minScore;
  const shouldLogReject = analysis.rejected && analysis.rejectReasons.some((reason) => reason.includes('sideways') || reason.includes('score'));
  if ((shouldLogSignal || shouldLogReject) && Date.now() - state.lastLogAt >= 15_000) {
    const reasons = analysis.rejected ? analysis.rejectReasons.join('; ') : analysis.reasons.join('; ');
    console.log(`[analysis] ${item.exchange}:${item.pair} regime=${analysis.regime} setup=${analysis.setupType ?? 'none'} score=${analysis.score} dir=${analysis.direction ?? 'flat'} ${analysis.rejected ? 'reject' : 'signal'}: ${reasons}`);
    state.lastLogAt = Date.now();
  }
  return analysis;
}

function analysisToTradeSignal(analysis: AnalysisSignal | null): Signal | null {
  if (!analysis || analysis.rejected || !analysis.direction || !analysis.setupType) return null;
  const reason = `${analysis.setupType} score=${analysis.score} regime=${analysis.regime}${analysis.reasons.length ? ` — ${analysis.reasons[0]}` : ''}`;
  if (analysis.direction === 'long') {
    return { side: 'buy', strength: analysis.score / 100, reason };
  }
  return { side: 'sell', strength: analysis.score / 100, reason };
}

export function __resetTradeStateForTests(): void {
  openPositions.clear();
  pendingLiquidations.clear();
  lastExitAt.clear();
  closedTrades.splice(0, closedTrades.length);
  histories.clear();
  analysisStates.clear();
  restoredTradeState = false;
  dailyPnl = 0;
  dailyPnlDate = new Date().toDateString();
  dailyEquityBaselineUsd = 0;
}

export function __seedAnalysisStateForTests(exchange: string, pair: string, state: Omit<PersistedAnalysisState, 'exchange' | 'pair'>): void {
  analysisStates.set(`${exchange}:${pair}`, {
    entryCandles: state.entryCandles,
    confirmCandles: state.confirmCandles,
    biasCandles: state.biasCandles,
    pendingSnapshots: [],
    bootstrapPromise: null,
    bootstrapped: true,
    lastAnalysis: state.lastAnalysis,
    lastLogAt: 0,
  });
}

export function __getAnalysisStateForTests(exchange: string, pair: string): PersistedAnalysisState | null {
  const state = analysisStates.get(`${exchange}:${pair}`);
  if (!state) return null;
  return {
    exchange,
    pair,
    entryCandles: state.entryCandles,
    confirmCandles: state.confirmCandles,
    biasCandles: state.biasCandles,
    lastAnalysis: state.lastAnalysis,
  };
}

function clearTrackedPosition(posKey: string, exchange: string) {
  openPositions.delete(posKey);
}

async function actualBaseBalanceFor(exchange: string, pair: string): Promise<number> {
  const base = baseAssetForPair(pair);
  if (exchange === 'kraken') {
    const bal = await getKrakenBalance();
    for (const alias of KRAKEN_BASE_ALIASES[base] ?? [base]) {
      const amount = parseFloat(bal[alias] ?? '0');
      if (amount > 0) return amount;
    }
    return 0;
  }
  if (exchange === 'coinbase') {
    const bal = await getCoinbaseBalance();
    return Math.max(0, parseFloat(bal[base] ?? '0'));
  }
  if (exchange === 'binance-us') {
    const bal = await getBinanceBalance();
    return Math.max(0, parseFloat(bal[base] ?? '0'));
  }
  return 0;
}

async function maybeLiquidateUntrackedHoldingForFunds(exchange: string, targetPair: string): Promise<boolean> {
  if (hasPositionOnExchange(exchange)) return false;

  let balance: Record<string, string> = {};
  if (exchange === 'kraken') {
    balance = await getKrakenBalance();
  } else if (exchange === 'coinbase') {
    balance = await getCoinbaseBalance();
  } else if (exchange === 'binance-us') {
    balance = await getBinanceBalance();
  }

  const candidates = findNonStableHoldings(balance)
    .map((holding) => {
      const pair = exchange === 'kraken' ? krakenPairForAsset(holding.asset) : `${holding.asset}-USD`;
      const key = `${exchange}:${pair}`;
      if (pair === targetPair) return null;
      if (openPositions.has(key)) return null;
      const bid = latestUsdBidForPair(pair, exchange);
      const usdValue = holding.amount * bid;
      if (!Number.isFinite(usdValue) || usdValue < MIN_SPENDABLE_QUOTE_USD) return null;
      return { asset: holding.asset, pair, amount: holding.amount, bid, usdValue };
    })
    .filter((item): item is { asset: string; pair: string; amount: number; bid: number; usdValue: number } => !!item)
    .sort((a, b) => b.usdValue - a.usdValue);

  const candidate = candidates[0];
  if (!candidate) return false;

  const availableBase = await actualBaseBalanceFor(exchange, candidate.pair);
  const sellVolume = Math.min(candidate.amount, availableBase * 0.995);
  if (!Number.isFinite(sellVolume) || sellVolume <= 0) return false;

  console.log(`[trade] FREE FUNDS ${exchange}:${candidate.pair} value≈$${candidate.usdValue.toFixed(2)} to fund ${targetPair}`);
  if (exchange === 'kraken') {
    const krakenPair = candidate.pair.replace('-', '').replace('BTC', 'XBT');
    await placeKrakenOrder({ pair: krakenPair, type: 'sell', ordertype: 'market', volume: sellVolume.toFixed(8) });
  } else if (exchange === 'coinbase') {
    await placeCoinbaseOrder({ productId: candidate.pair, side: 'SELL', size: sellVolume.toFixed(8) });
  } else if (exchange === 'binance-us') {
    const symbol = candidate.pair.replace('-', '');
    await placeBinanceOrder({ symbol, side: 'SELL', type: 'MARKET', quantity: sellVolume.toFixed(8) });
  }
  pendingLiquidations.delete(`${exchange}:${candidate.pair}`);
  return true;
}

function maybeRotatePosition(item: TradeItem, sig: Signal, strategyId: string): Opportunity | null {
  const current = currentPositionOnExchange(item.exchange);
  if (!current || current.pair === item.pair) return null;
  if (sig.side !== 'buy' || sig.strength < 0.85) return null;

  const currentSnap = latestSnapshotFor(item.exchange, current.pair);
  if (!currentSnap) return null;

  const pnlPct = (currentSnap.bid - current.entryPrice) / current.entryPrice;
  const elapsedMs = Date.now() - current.entryTime;
  if (elapsedMs < 60_000 && pnlPct > -0.002) return null;
  if (pnlPct >= TAKE_PROFIT_PCT * 0.75) return null;

  const feeRate = item.exchange === 'kraken' ? KRAKEN_TAKER_FEE : item.exchange === 'coinbase' ? COINBASE_TAKER_FEE : BINANCE_TAKER_FEE;
  const fee = currentSnap.bid * current.volume * feeRate;
  const grossPnl = (currentSnap.bid - current.entryPrice) * current.volume;
  const netPnl = grossPnl - fee;
  const exitReason = `rotate to ${item.pair}: ${sig.reason}`;
  attemptedExchangeActions.add(item.exchange);
  console.log(`[trade] ROTATE ${item.exchange}:${current.pair} -> ${item.pair} gross=$${grossPnl.toFixed(4)} net=$${netPnl.toFixed(4)} sig=${sig.strength.toFixed(2)}`);
  return publishExitSignal({
    strategyId,
    exchange: item.exchange,
    pair: current.pair,
    snap: currentSnap,
    signal: { side: 'sell', strength: sig.strength, reason: exitReason },
    position: current,
    projectedReturn: currentSnap.bid * current.volume,
    projectedProfit: netPnl,
    titleReason: exitReason,
  });
}

async function refreshSpendableQuoteBalances(): Promise<void> {
  if (Date.now() - lastQuoteBalanceRefresh < QUOTE_BALANCE_REFRESH_MS) return;
  lastQuoteBalanceRefresh = Date.now();

  try {
    const [bal, openOrders] = await Promise.all([getKrakenBalance(), getKrakenOpenOrders()]);
    accountBalances.kraken = bal;
    const now = Date.now();
    let reservedUsd = 0;
    for (const [txid, order] of Object.entries(openOrders ?? {})) {
      const type = order?.descr?.type?.toLowerCase?.() ?? '';
      const pair = order?.descr?.pair?.toUpperCase?.() ?? '';
      const price = parseFloat(order?.descr?.price ?? '0');
      const vol = parseFloat(order?.vol ?? '0');
      const volExec = parseFloat(order?.vol_exec ?? '0');
      const remaining = Math.max(0, vol - volExec);
      const openAtMs = Number((order as { opentm?: number }).opentm ?? 0) * 1000;
      if (type !== 'buy' || !(remaining > 0)) continue;
      if (pair.endsWith('USD') && Number.isFinite(price) && price > 0) {
        reservedUsd += remaining * price;
      }
      if (openAtMs > 0 && now - openAtMs > STALE_OPEN_BUY_ORDER_MS) {
        try {
          await cancelKrakenOrder(txid);
          console.log(`[trade] canceled stale kraken buy order ${pair} txid=${txid}`);
          if (pair.endsWith('USD') && Number.isFinite(price) && price > 0) {
            reservedUsd = Math.max(0, reservedUsd - (remaining * price));
          }
        } catch (cancelError) {
          console.log(`[trade] failed to cancel stale kraken order ${txid}: ${(cancelError as Error).message}`);
        }
      }
    }
    spendableQuoteBalances.kraken = {
      USD: Math.max(0, parseFloat(bal.ZUSD ?? '0') - reservedUsd),
      USDC: parseFloat(bal.USDC ?? '0'),
      USDT: parseFloat(bal.USDT ?? '0'),
    };
  } catch (e) {
    spendableQuoteBalances.kraken = {};
    accountBalances.kraken = {};
    const msg = (e as Error).message;
    if (msg.includes('Temporary lockout')) {
      krakenHydrationBlockedUntil = Math.max(krakenHydrationBlockedUntil, Date.now() + KRAKEN_HYDRATION_LOCKOUT_MS);
    }
  }

  try {
    const [availableBal, totalBal] = await Promise.all([getCoinbaseAvailableBalance(), getCoinbaseBalance()]);
    accountBalances.coinbase = totalBal;
    spendableQuoteBalances.coinbase = {
      USD: parseFloat(availableBal.USD ?? '0'),
      USDC: parseFloat(availableBal.USDC ?? '0'),
      USDT: parseFloat(availableBal.USDT ?? '0'),
    };
  } catch {
    spendableQuoteBalances.coinbase = {};
    accountBalances.coinbase = {};
  }

  try {
    const bal = await getBinanceBalance();
    accountBalances['binance-us'] = bal;
    spendableQuoteBalances['binance-us'] = {
      USD: parseFloat(bal.USD ?? '0'),
      USDC: parseFloat(bal.USDC ?? '0'),
      USDT: parseFloat(bal.USDT ?? '0'),
    };
  } catch {
    spendableQuoteBalances['binance-us'] = {};
    accountBalances['binance-us'] = {};
  }
}

function spendableQuoteFor(exchange: string, pair: string): number {
  const quoteAsset = quoteAssetForPair(pair);
  let spendable = Math.max(0, spendableQuoteBalances[exchange]?.[quoteAsset] ?? 0);
  if (quoteAsset === 'USD' && spendable < MIN_SPENDABLE_QUOTE_USD) {
    spendable += Math.max(0, spendableQuoteBalances[exchange]?.USDC ?? 0);
    spendable += Math.max(0, spendableQuoteBalances[exchange]?.USDT ?? 0);
  }
  return spendable;
}

async function refreshMarketMinimums(pairs: string[]): Promise<void> {
  const uniquePairs = [...new Set(pairs)];
  for (const pair of uniquePairs) {
    const priceCandidates = TRADE_FEEDS
      .map(({ exchange }) => Number(histories.get(`${exchange}:${pair}`)?.at(-1)?.ask))
      .filter((price): price is number => Number.isFinite(price) && price > 0);
    const referencePrice = priceCandidates[0] ?? 0;

    if (referencePrice > 0) {
      const krakenPair = pair.replace('-', '').replace('BTC', 'XBT');
      const krakenMinVolume = await getKrakenPairMinVolume(krakenPair);
      if (Number.isFinite(krakenMinVolume) && krakenMinVolume && krakenMinVolume > 0) {
        minExecutableUsdByMarket.set(`kraken:${pair}`, krakenMinVolume * referencePrice);
      }

      const binanceSymbol = pair.replace('-', '');
      const binanceRules = await getBinanceTradingRules(binanceSymbol);
      if (binanceRules) {
        const minQtyUsd = binanceRules.minQty ? binanceRules.minQty * referencePrice : 0;
        const minNotionalUsd = binanceRules.minNotional ?? 0;
        const minUsd = Math.max(minQtyUsd, minNotionalUsd);
        if (minUsd > 0) minExecutableUsdByMarket.set(`binance-us:${pair}`, minUsd);
      }
    }
  }
}

async function maybeAutoConvertBinanceQuote(targetQuote: string, neededQuote: number): Promise<number> {
  const bal = await getBinanceBalance();
  let direct = parseFloat(bal[targetQuote] ?? '0') * 0.995;
  if (direct >= Math.min(neededQuote, MAX_POSITION_USD)) return Math.min(direct, 99.50);

  const conversionPaths: Record<string, Array<{ from: string; symbol: string }>> = {
    USD: [
      { from: 'USDC', symbol: 'USDCUSD' },
      { from: 'USDT', symbol: 'USDTUSD' },
    ],
    USDC: [
      { from: 'USD', symbol: 'USDUSDC' },
      { from: 'USDT', symbol: 'USDTUSDC' },
    ],
    USDT: [
      { from: 'USD', symbol: 'USDUSDT' },
      { from: 'USDC', symbol: 'USDCUSDT' },
    ],
  };

  for (const path of conversionPaths[targetQuote] ?? []) {
    const sourceFree = parseFloat(bal[path.from] ?? '0') * 0.995;
    if (sourceFree < MIN_SPENDABLE_QUOTE_USD) continue;
    if (!(await hasBinanceTradingSymbol(path.symbol))) continue;
    const convertQty = Math.min(sourceFree, Math.max(neededQuote, MIN_SPENDABLE_QUOTE_USD), 99.50);
    console.log(`[trade] AUTO-CONVERT binance-us ${path.from}->${targetQuote} via ${path.symbol} qty=${convertQty.toFixed(8)}`);
    await placeBinanceOrder({ symbol: path.symbol, side: 'SELL', type: 'MARKET', quantity: convertQty.toFixed(8) });
    const refreshed = await getBinanceBalance();
    direct = parseFloat(refreshed[targetQuote] ?? '0') * 0.995;
    if (direct >= MIN_SPENDABLE_QUOTE_USD) return Math.min(direct, 99.50);
  }

  return Math.min(direct, 99.50);
}

async function maybeAutoConvertCoinbaseQuote(targetQuote: string, neededQuote: number): Promise<number> {
  const bal = await getCoinbaseAvailableBalance();
  let direct = parseFloat(bal[targetQuote] ?? '0') * 0.995;
  if (direct >= Math.min(neededQuote, MAX_POSITION_USD)) return Math.min(direct, 99.50);
  if (targetQuote !== 'USD') return Math.min(direct, 99.50);

  for (const source of ['USDC', 'USDT']) {
    const sourceFree = parseFloat(bal[source] ?? '0') * 0.995;
    if (sourceFree < MIN_SPENDABLE_QUOTE_USD) continue;
    const productId = `${source}-USD`;
    if (!(await hasCoinbaseTradingProduct(productId))) continue;
    const convertQty = Math.min(sourceFree, Math.max(neededQuote, MIN_SPENDABLE_QUOTE_USD), 99.50);
    console.log(`[trade] AUTO-CONVERT coinbase ${source}->USD via ${productId} qty=${convertQty.toFixed(8)}`);
    await placeCoinbaseOrder({ productId, side: 'SELL', size: convertQty.toFixed(8) });
    const refreshed = await getCoinbaseAvailableBalance();
    direct = parseFloat(refreshed.USD ?? '0') * 0.995;
    if (direct >= MIN_SPENDABLE_QUOTE_USD) return Math.min(direct, 99.50);
  }

  return Math.min(direct, 99.50);
}

async function maybeAutoConvertKrakenQuote(targetQuote: string, neededQuote: number): Promise<number> {
  const bal = await getKrakenBalance();
  let direct = parseFloat(bal[krakenQuoteBalanceKey(targetQuote)] ?? '0') * 0.995;
  if (direct >= Math.min(neededQuote, MAX_POSITION_USD)) return Math.min(direct, 99.50);
  if (targetQuote !== 'USD') return Math.min(direct, 99.50);

  const conversionPairs = [
    { source: 'USDC', pair: 'USDCUSD' },
    { source: 'USDT', pair: 'USDTUSD' },
  ];
  for (const path of conversionPairs) {
    const sourceFree = parseFloat(bal[path.source] ?? '0') * 0.995;
    if (sourceFree < MIN_SPENDABLE_QUOTE_USD) continue;
    if (!(await hasKrakenTradingPair(path.pair))) continue;
    const convertQty = Math.min(sourceFree, Math.max(neededQuote, MIN_SPENDABLE_QUOTE_USD), 99.50);
    console.log(`[trade] AUTO-CONVERT kraken ${path.source}->USD via ${path.pair} qty=${convertQty.toFixed(8)}`);
    await placeKrakenOrder({ pair: path.pair, type: 'sell', ordertype: 'market', volume: convertQty.toFixed(8) });
    const refreshed = await getKrakenBalance();
    direct = parseFloat(refreshed.ZUSD ?? '0') * 0.995;
    if (direct >= MIN_SPENDABLE_QUOTE_USD) return Math.min(direct, 99.50);
  }

  return Math.min(direct, 99.50);
}

async function hydrateKrakenPositions(): Promise<void> {
  if (Date.now() < krakenHydrationBlockedUntil) {
    throw new Error(`Kraken hydration backoff ${Math.ceil((krakenHydrationBlockedUntil - Date.now()) / 1000)}s remaining`);
  }
  const { getBalance, getTradeHistory } = await import('@b1dz/source-crypto-arb');
  let balance: Record<string, string>;
  let tradeHistory: Awaited<ReturnType<typeof getTradeHistory>>;
  try {
    balance = await getBalance();
    tradeHistory = await getTradeHistory();
  } catch (e) {
    const msg = (e as Error).message;
    if (msg.includes('Temporary lockout')) {
      krakenHydrationBlockedUntil = Date.now() + KRAKEN_HYDRATION_LOCKOUT_MS;
    }
    throw e;
  }
  krakenHydrationBlockedUntil = 0;
  const holdings = findNonStableHoldings(balance);
  if (holdings.length === 0) return;

  console.log(`[trade] found ${holdings.length} crypto holdings on kraken`);

  const trades = Object.values(tradeHistory).sort((a, b) => b.time - a.time);
  for (const holding of holdings) {
    const pair = krakenPairForAsset(holding.asset);
    const base = pair.replace('-USD', '');
    const buyTrade = trades.find((trade) => {
      if (trade.type !== 'buy') return false;
      const tradePair = trade.pair.toUpperCase();
      return tradePair.includes(base.toUpperCase()) && tradePair.includes('USD');
    });
    if (!buyTrade) {
      console.log(`[trade] holding kraken:${pair}=${holding.amount} but no buy trade found in history`);
      rememberLiquidation('kraken', pair, holding.amount, 'no buy trade found');
      continue;
    }
    const entryPrice = parseFloat(buyTrade.price);
    if (!isFinite(entryPrice) || entryPrice <= 0) continue;
    restorePosition('kraken', pair, holding.amount, entryPrice, buyTrade.time * 1000, 'from trade history');
  }

  if (trades.length > 0) {
    console.log(`[trade] hydrated ${trades.length} kraken trades, ${openPositions.size} open positions`);
  }
}

async function hydrateCoinbasePositions(): Promise<void> {
  const balance = await getCoinbaseBalance();
  const fills = (await getCoinbaseFills(200)).sort((a, b) => Date.parse(b.trade_time) - Date.parse(a.trade_time));
  const holdings = findNonStableHoldings(balance);
  if (holdings.length === 0) return;

  console.log(`[trade] found ${holdings.length} crypto holdings on coinbase`);

  for (const holding of holdings) {
    const pair = `${holding.asset}-USD`;
    const buyFill = fills.find((fill) => fill.side.toUpperCase() === 'BUY' && fill.product_id === pair);
    if (!buyFill) {
      console.log(`[trade] holding coinbase:${pair}=${holding.amount} but no buy fill found in history`);
      rememberLiquidation('coinbase', pair, holding.amount, 'no buy fill found');
      continue;
    }
    const entryPrice = parseFloat(buyFill.price);
    if (!isFinite(entryPrice) || entryPrice <= 0) continue;
    restorePosition('coinbase', pair, holding.amount, entryPrice, Date.parse(buyFill.trade_time), 'from fill history');
  }
}

async function hydrateBinancePositions(): Promise<void> {
  const balance = await getBinanceBalance();
  const holdings = findNonStableHoldings(balance);
  if (holdings.length === 0) return;

  console.log(`[trade] found ${holdings.length} crypto holdings on binance-us`);

  for (const holding of holdings) {
    const pair = `${holding.asset}-USD`;
    const symbol = pair.replace('-', '');
    const trades = (await getBinanceTrades(symbol, 1000)).sort((a, b) => b.time - a.time);
    const buyTrade = trades.find((trade) => trade.isBuyer);
    if (!buyTrade) {
      console.log(`[trade] holding binance-us:${pair}=${holding.amount} but no buy trade found in history`);
      rememberLiquidation('binance-us', pair, holding.amount, 'no buy trade found');
      continue;
    }
    const entryPrice = parseFloat(buyTrade.price);
    if (!isFinite(entryPrice) || entryPrice <= 0) continue;
    restorePosition('binance-us', pair, holding.amount, entryPrice, buyTrade.time, 'from trade history');
  }
}

/**
 * Reconstruct positions from exchange data (source of truth).
 */
async function hydrateFromExchange() {
  if (hydratedExchanges.size === 3) return;

  const steps: Array<{ exchange: string; fn: () => Promise<void> }> = [
    { exchange: 'kraken', fn: hydrateKrakenPositions },
    { exchange: 'coinbase', fn: hydrateCoinbasePositions },
    { exchange: 'binance-us', fn: hydrateBinancePositions },
  ];

  for (const step of steps) {
    if (hydratedExchanges.has(step.exchange)) continue;
    try {
      await step.fn();
      hydratedExchanges.add(step.exchange);
    } catch (e) {
      console.error(`[trade] ${step.exchange} hydration failed: ${(e as Error).message}`);
    }
  }

  if (hydratedExchanges.size === steps.length && openPositions.size === 0) {
    console.log('[trade] no crypto holdings found — starting clean');
  }
}

export function restorePersistedTradeState(state: Record<string, unknown> | undefined) {
  if (restoredTradeState) return;
  restoredTradeState = true;
  const tradeState = (state?.tradeState as Record<string, unknown> | undefined) ?? {};
  const savedPositions = Array.isArray(tradeState.positions) ? tradeState.positions as Position[] : [];
  openPositions.clear();
  for (const pos of savedPositions) {
    if (
      !pos
      || typeof pos.exchange !== 'string'
      || typeof pos.pair !== 'string'
      || !Number.isFinite(pos.entryPrice)
      || !Number.isFinite(pos.volume)
      || !Number.isFinite(pos.entryTime)
    ) continue;
    openPositions.set(`${pos.exchange}:${pos.pair}`, {
      pair: pos.pair,
      exchange: pos.exchange,
      entryPrice: pos.entryPrice,
      volume: pos.volume,
      entryTime: pos.entryTime,
      highWaterMark: Number.isFinite(pos.highWaterMark) ? pos.highWaterMark : pos.entryPrice,
      strategyId: pos.strategyId,
    });
  }
  lastExitAt.clear();
  const savedExits = Array.isArray(tradeState.exits) ? tradeState.exits as { pair: string; at: number }[] : [];
  for (const exit of savedExits) {
    if (!exit || typeof exit.pair !== 'string' || !Number.isFinite(exit.at)) continue;
    lastExitAt.set(exit.pair, exit.at);
  }
  const savedDailyPnlDate = tradeState.dailyPnlDate;
  if (typeof savedDailyPnlDate === 'string') dailyPnlDate = savedDailyPnlDate;
  if (Number.isFinite(tradeState.dailyEquityBaselineUsd)) {
    dailyEquityBaselineUsd = Math.max(0, Number(tradeState.dailyEquityBaselineUsd));
  }
  const savedClosedTrades = Array.isArray(tradeState.closedTrades) ? tradeState.closedTrades as ClosedTrade[] : [];
  closedTrades.splice(0, closedTrades.length, ...savedClosedTrades);
  restoreAnalysisStates(tradeState.analysisStates);
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  dailyPnl = closedTrades
    .filter((trade) => trade.exitTime >= todayStart.getTime())
    .reduce((sum, trade) => sum + trade.netPnl, 0);
}

/** Serialize positions/cooldowns/dailyPnl for persistence. */
export function serializeTradeState(): Record<string, unknown> {
  return {
    positions: [...openPositions.values()],
    exits: [...lastExitAt.entries()].map(([pair, at]) => ({ pair, at })),
    dailyPnl,
    dailyPnlDate,
    dailyEquityBaselineUsd,
    closedTrades,
    analysisStates: serializeAnalysisStates(),
  };
}

function resetDailyStateIfNeeded() {
  const today = new Date().toDateString();
  if (today !== dailyPnlDate) {
    dailyPnl = 0;
    dailyPnlDate = today;
    dailyEquityBaselineUsd = 0;
  }
}

function refreshDailyEquityBaselineIfNeeded() {
  resetDailyStateIfNeeded();
  if (dailyEquityBaselineUsd > 0) return;
  const totalEquityUsd = estimateTotalEquityUsd();
  if (Number.isFinite(totalEquityUsd) && totalEquityUsd > 0) {
    dailyEquityBaselineUsd = totalEquityUsd;
  }
}

function dailyPnlPct(): number {
  resetDailyStateIfNeeded();
  if (!(dailyEquityBaselineUsd > 0)) return 0;
  return (dailyPnl / dailyEquityBaselineUsd) * 100;
}

function isDailyLossLimitHit(): boolean {
  refreshDailyEquityBaselineIfNeeded();
  if (!(dailyEquityBaselineUsd > 0)) return false;
  return dailyPnlPct() <= -DAILY_LOSS_LIMIT_PCT;
}

/** Live status snapshot for TUI display. */
export interface TradeStatus {
  positions: { exchange: string; pair: string; entryPrice: number; currentPrice: number; volume: number; pnlPct: number; pnlUsd: number; stopPrice: number; elapsed: string }[];
  position: { pair: string; entryPrice: number; currentPrice: number; volume: number; pnlPct: number; pnlUsd: number; stopPrice: number; elapsed: string } | null;
  dailyPnl: number;
  dailyPnlPct: number;
  dailyLossLimitHit: boolean;
  dailyLossLimitPct: number;
  cooldowns: { pair: string; remainingSec: number }[];
  eligiblePairs: number;
  observedPairs: number;
  ticksPerPair: Record<string, number>;
  exchangeStates: { exchange: string; readyPairs: number; warmingPairs: number; openPositions: number; blockedReason: string | null }[];
  lastSignal: string | null;
}

export function getTradeStatus(): TradeStatus {
  refreshDailyEquityBaselineIfNeeded();
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const trackedDailyPnl = closedTrades
    .filter((trade) => trade.exitTime >= todayStart.getTime())
    .reduce((sum, trade) => sum + trade.netPnl, 0);
  const positions = [...openPositions.values()]
    .map((pos) => {
      const currentPrice = histories.get(`${pos.exchange}:${pos.pair}`)?.at(-1)?.bid ?? pos.entryPrice;
      const pnlPct = ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100;
      const pnlUsd = (currentPrice - pos.entryPrice) * pos.volume;
      return {
        exchange: pos.exchange,
        pair: pos.pair,
        entryPrice: pos.entryPrice,
        currentPrice,
        volume: pos.volume,
        pnlPct,
        pnlUsd,
        stopPrice: trailingStopPrice(pos),
        elapsed: `${Math.floor((Date.now() - pos.entryTime) / 60000)}m`,
      };
    })
    .filter((pos) => (pos.currentPrice * pos.volume) >= DUST_USD_THRESHOLD);
  const pos = positions[0] ?? null;
  const cooldowns: { pair: string; remainingSec: number }[] = [];
  for (const [pair, exitTime] of lastExitAt) {
    const remaining = Math.max(0, COOLDOWN_MS - (Date.now() - exitTime));
    if (remaining > 0) cooldowns.push({ pair, remainingSec: Math.ceil(remaining / 1000) });
  }
  const ticksPerPair: Record<string, number> = {};
  for (const [pair, hist] of histories) ticksPerPair[pair] = hist.length;
  const exchangeStates = TRADE_FEEDS.map(({ exchange }) => {
    const openCount = positions.filter((p) => p.exchange === exchange).length;
    const histEntries = [...histories.entries()].filter(([key]) => key.startsWith(`${exchange}:`));
    const readyPairs = histEntries.filter(([, hist]) => hist.length >= WARMUP_TICKS).length;
    const warmingPairs = histEntries.filter(([, hist]) => hist.length > 0 && hist.length < WARMUP_TICKS).length;
    const blockedReason = openCount > 0 ? 'open position' : null;
    return { exchange, readyPairs, warmingPairs, openPositions: openCount, blockedReason };
  });

  return {
    positions,
    position: pos,
    dailyPnl: trackedDailyPnl,
    dailyPnlPct: dailyEquityBaselineUsd > 0 ? (trackedDailyPnl / dailyEquityBaselineUsd) * 100 : 0,
    dailyLossLimitHit: dailyEquityBaselineUsd > 0 ? ((trackedDailyPnl / dailyEquityBaselineUsd) * 100) <= -DAILY_LOSS_LIMIT_PCT : false,
    dailyLossLimitPct: DAILY_LOSS_LIMIT_PCT,
    cooldowns,
    eligiblePairs: lastEligiblePairs.length,
    observedPairs: new Set([...histories.keys()].map((key) => key.split(':').slice(1).join(':'))).size,
    ticksPerPair,
    exchangeStates,
    lastSignal: null,
  };
}

/** Compute the current trailing stop price for a position. */
function trailingStopPrice(pos: Position): number {
  const pnlPct = (pos.highWaterMark - pos.entryPrice) / pos.entryPrice;

  if (pnlPct >= LOCK_TRIGGER_PCT) {
    // Lock in profit: stop at entry + LOCK_STOP_PCT
    return pos.entryPrice * (1 + LOCK_STOP_PCT);
  }
  if (pnlPct >= BREAKEVEN_TRIGGER_PCT) {
    // Breakeven stop
    return pos.entryPrice;
  }
  // Initial stop
  return pos.entryPrice * (1 - INITIAL_STOP_PCT);
}

// ─── Source ────────────────────────────────────────────────────

// Import the composite strategy dynamically to avoid circular deps
let defaultStrategy: Strategy | null = null;
async function getDefaultStrategy(): Promise<Strategy> {
  if (!defaultStrategy) {
    const mod = await import('./strategies.js');
    defaultStrategy = mod.compositeStrategy;
  }
  return defaultStrategy;
}

export function makeCryptoTradeSource(strategy?: Strategy): Source<TradeItem> {
  const strategyId = strategy?.id ?? 'multi-signal';

  return {
    id: `crypto-trade:multi:${strategyId}`,
    pollIntervalMs: 5000,

    async poll(ctx) {
      restorePersistedTradeState(ctx.state);
      // Restore positions from exchange APIs on first tick (source of truth)
      await hydrateFromExchange();
      await refreshSpendableQuoteBalances();
      pendingBuyExchange = null;
      attemptedExchangeActions.clear();
      tradePollCount++;

      const PAIRS = await getActivePairs();
      lastEligiblePairs = [...PAIRS];
      const items: TradeItem[] = [];
      // Poll each pair on each exchange — one position per exchange
      for (const { feed, exchange } of TRADE_FEEDS) {
        for (const pair of PAIRS) {
          const snap = await feed.snapshot(pair);
          if (!snap) continue;
          if (!isFinite(snap.bid) || !isFinite(snap.ask) || snap.bid <= 0 || snap.ask <= 0) continue;
          ensureAnalysisBootstrap(exchange, pair);
          updateAnalysisState(exchange, pair, snap);
          const histKey = `${exchange}:${pair}`;
          const hist = histories.get(histKey) ?? [];
          hist.push(snap);
          while (hist.length > 300) hist.shift();
          histories.set(histKey, hist);
          const cooldownActive = (Date.now() - (lastExitAt.get(pair) ?? 0)) < COOLDOWN_MS;
          const item: TradeItem = { pair, exchange, snap, history: [...hist], analysis: null };
          item.analysis = getAnalysisForItem(item, cooldownActive);
          items.push(item);

          // Update high water mark for open positions
          const posKey = `${exchange}:${pair}`;
          const pos = openPositions.get(posKey);
          if (pos && snap.bid > pos.highWaterMark) {
            pos.highWaterMark = snap.bid;
          }

          // Keep raw logs useful: positions every tick, warmup checkpoints,
          // and occasional readiness markers. Strategy-specific [multi]/[scalp]
          // logs carry the actual assessment feed.
          if (pos) {
            const pnlPct = ((snap.bid - pos.entryPrice) / pos.entryPrice) * 100;
            const stopPct = ((trailingStopPrice(pos) - pos.entryPrice) / pos.entryPrice) * 100;
            console.log(`[trade] ${exchange}:${pair} $${snap.bid.toFixed(2)} pos:${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(3)}% stop:${stopPct >= 0 ? '+' : ''}${stopPct.toFixed(3)}%`);
          } else if (hist.length < WARMUP_TICKS && [1, 5, 10, 15, WARMUP_TICKS - 1].includes(hist.length)) {
            console.log(`[trade] ${exchange}:${pair} $${snap.bid.toFixed(2)} warming ${hist.length}/${WARMUP_TICKS}`);
          } else if (hist.length === WARMUP_TICKS || hist.length % 20 === 0) {
            console.log(`[trade] ${exchange}:${pair} $${snap.bid.toFixed(2)} ready ticks=${hist.length}`);
          }
        }
      }
      await refreshMarketMinimums(PAIRS);
      refreshDailyEquityBaselineIfNeeded();
      if (tradePollCount % 4 === 0) {
        const status = getTradeStatus();
        const summary = status.exchangeStates.map((s) => {
          const state = s.blockedReason ? `blocked:${s.blockedReason}` : (s.warmingPairs > 0 ? 'warming' : 'ready');
          return `${s.exchange}=${state} ready=${s.readyPairs} warming=${s.warmingPairs} open=${s.openPositions}`;
        }).join(' | ');
        console.log(`[trade] status ${summary}`);
      }
      return items;
    },

    evaluate(item): Opportunity | null {
      const activeStrategy = strategy ?? defaultStrategy ?? momentumStrategy;
      const analysisSignal = analysisToTradeSignal(item.analysis);

      // ── Check exits first ──
      const posKey = `${item.exchange}:${item.pair}`;
      const pos = openPositions.get(posKey);
      if (pos) {
        const pnlPct = (item.snap.bid - pos.entryPrice) / pos.entryPrice;
        const stopPrice = trailingStopPrice(pos);
        const elapsed = Date.now() - pos.entryTime;
        const notional = item.snap.bid * pos.volume;
        const minExecutableUsd = minExecutableUsdByMarket.get(`${item.exchange}:${item.pair}`) ?? 0;

        if (notional < DUST_USD_THRESHOLD || (minExecutableUsd > 0 && notional < minExecutableUsd)) {
          openPositions.delete(posKey);
          console.log(`[trade] CLEAR DUST ${item.exchange}:${item.pair} value=$${notional.toFixed(2)} min=$${minExecutableUsd.toFixed(2)}`);
          return null;
        }

        let exitReason = '';

        // Take-profit
        if (pnlPct >= TAKE_PROFIT_PCT) {
          exitReason = `take-profit +${(pnlPct * 100).toFixed(2)}%`;
        }
        // Trailing stop hit
        else if (item.snap.bid <= stopPrice) {
          exitReason = `trailing stop at $${stopPrice.toFixed(2)} (${((stopPrice - pos.entryPrice) / pos.entryPrice * 100).toFixed(2)}%)`;
        }
        // Time-based flat exit
        else if (elapsed >= TIME_EXIT_MS && Math.abs(pnlPct) < TIME_EXIT_FLAT_PCT) {
          exitReason = `time exit after ${(elapsed / 60000).toFixed(0)}min (flat ${(pnlPct * 100).toFixed(3)}%)`;
        }
        // Strategy sell signal
        else {
          const sig = analysisSignal ?? activeStrategy.evaluate(item.snap, item.history);
          if (sig?.side === 'sell' && sig.strength >= 0.75) {
            exitReason = `strategy sell: ${sig.reason}`;
          }
        }

        if (exitReason) {
          attemptedExchangeActions.add(item.exchange);
          const sellFee = item.snap.bid * pos.volume * KRAKEN_TAKER_FEE;
          const grossPnl = (item.snap.bid - pos.entryPrice) * pos.volume;
          const netPnl = grossPnl - sellFee;
          console.log(`[trade] EXIT ${item.pair}: ${exitReason} gross=$${grossPnl.toFixed(4)} net=$${netPnl.toFixed(4)}`);
          return publishExitSignal({
            strategyId,
            exchange: item.exchange,
            pair: item.pair,
            snap: item.snap,
            signal: { side: 'sell', strength: 1, reason: exitReason },
            position: pos,
            analysis: item.analysis,
            projectedReturn: item.snap.bid * pos.volume,
            projectedProfit: netPnl,
            titleReason: exitReason,
          });
        }
        return null; // hold position
      }

      // ── Liquidate untracked holdings before opening a fresh position ──
      const liquidation = pendingLiquidations.get(posKey);
      if (liquidation && !currentPositionOnExchange(item.exchange)) {
        attemptedExchangeActions.add(item.exchange);
        console.log(`[trade] LIQUIDATE ${item.exchange}:${item.pair} untracked volume=${liquidation.volume.toFixed(8)}`);
        return publishLiquidationSignal({
          strategyId,
          exchange: item.exchange,
          pair: item.pair,
          snap: item.snap,
          signal: { side: 'sell', strength: 1, reason: 'liquidate untracked holding' },
          liquidation,
        });
      }

      // ── Check entries ──

      // Daily loss limit
      if (isDailyLossLimitHit()) {
        if (Date.now() - lastDailyLossLimitLogAt >= 60_000) {
          console.log(`[trade] DAILY LOSS LIMIT HIT ($${dailyPnl.toFixed(2)} / ${dailyPnlPct().toFixed(2)}%) — trading halted, scanning only`);
          lastDailyLossLimitLogAt = Date.now();
        }
        return null;
      }

      // Cooldown
      const lastExit = lastExitAt.get(item.pair) ?? 0;
      if (Date.now() - lastExit < COOLDOWN_MS) {
        return null; // silent — don't spam logs during cooldown
      }

      // One position per exchange
      const tradeExchange = item.exchange;
      if (attemptedExchangeActions.has(tradeExchange)) return null;
      if (pendingBuyExchange === tradeExchange) return null;
      if (currentLiquidationOnExchange(tradeExchange)) return null;

      // Run strategy
      const sig = analysisSignal ?? activeStrategy.evaluate(item.snap, item.history);
      if (!sig || sig.side !== 'buy') return null;
      if (sig.strength < (DEFAULT_ANALYSIS_CONFIG.thresholds.minScore / 100)) return null;

      // Already have a position for this pair on this exchange
      const posKey2 = `${tradeExchange}:${item.pair}`;
      if (openPositions.has(posKey2)) return null;

      if (hasPositionOnExchange(tradeExchange)) {
        return maybeRotatePosition(item, sig, strategyId);
      }

      // Skip actionable entries when the exchange does not have enough spendable
      // quote balance for this market.
      const spendableQuote = spendableQuoteFor(tradeExchange, item.pair);
      if (spendableQuote < MIN_SPENDABLE_QUOTE_USD) return null;
      const spendBudget = Math.min(spendableQuote, MAX_POSITION_USD) * 0.98;
      const minExecutableUsd = minExecutableUsdByMarket.get(`${tradeExchange}:${item.pair}`) ?? 0;
      if (minExecutableUsd > 0 && spendBudget < minExecutableUsd) return null;

      // Check profitability: need to clear round-trip fees with take-profit
      const roundTripFee = 2 * KRAKEN_TAKER_FEE; // 0.52%
      const netTakeProfit = TAKE_PROFIT_PCT - roundTripFee;
      if (netTakeProfit <= 0) {
        console.log(`[trade] ${item.pair} take-profit ${(TAKE_PROFIT_PCT * 100).toFixed(1)}% won't cover fees ${(roundTripFee * 100).toFixed(2)}%`);
        return null;
      }

      const price = item.snap.ask;
      // Lock immediately so no other pair triggers in this tick
      pendingBuyExchange = tradeExchange;
      attemptedExchangeActions.add(tradeExchange);
      console.log(`[trade] ENTRY SIGNAL ${item.pair} @ $${price.toFixed(2)}: ${sig.reason} (str=${sig.strength.toFixed(2)})`);
      return publishEntrySignal({
        strategyId,
        exchange: item.exchange,
        pair: item.pair,
        snap: item.snap,
        signal: sig,
        analysis: item.analysis,
        projectedReturn: item.analysis?.takeProfit ?? (price * (1 + TAKE_PROFIT_PCT)),
        projectedProfit: price * netTakeProfit,
      });
    },

    async act(opp): Promise<ActionResult> {
      const meta = opp.metadata as unknown as { signal: Signal; snap: MarketSnapshot; position?: Position; strategy?: string; liquidation?: PendingLiquidation };
      const pair = meta.snap.pair;
      const exchange = meta.snap.exchange;

      if (meta.signal.side === 'sell') {
        if (meta.liquidation) {
          const liquidationKey = `${exchange}:${pair}`;
          try {
            const availableBase = await actualBaseBalanceFor(exchange, pair);
            const sellVolume = Math.min(meta.liquidation.volume, availableBase * 0.995);
            if (!Number.isFinite(sellVolume) || sellVolume <= 0 || sellVolume * meta.snap.bid < 0.01) {
              pendingLiquidations.delete(liquidationKey);
              return { ok: false, message: `cleared stale ${pair} liquidation on ${exchange} (no sellable balance)` };
            }
            let txInfo = '';
            if (exchange === 'kraken') {
              const krakenPair = pair.replace('-', '').replace('BTC', 'XBT');
              const result = await placeKrakenOrder({ pair: krakenPair, type: 'sell', ordertype: 'market', volume: sellVolume.toFixed(8) });
              txInfo = `${result.descr.order} txid=${result.txid}`;
            } else if (exchange === 'coinbase') {
              const result = await placeCoinbaseOrder({ productId: pair, side: 'SELL', size: sellVolume.toFixed(8) });
              txInfo = `orderId=${result.order_id}`;
            } else if (exchange === 'binance-us') {
              const symbol = pair.replace('-', '');
              const result = await placeBinanceOrder({ symbol, side: 'SELL', type: 'MARKET', quantity: sellVolume.toFixed(8) });
              txInfo = `orderId=${result.orderId}`;
            }
            pendingLiquidations.delete(liquidationKey);
            console.log(`[trade] LIQUIDATED ${exchange}:${pair} ${txInfo}`);
            return { ok: true, message: `liquidated ${sellVolume.toFixed(8)} on ${exchange}` };
          } catch (e) {
            const msg = (e as Error).message;
            if (msg.includes('below minQty') || msg.includes('MIN_NOTIONAL')) {
              pendingLiquidations.delete(liquidationKey);
            }
            console.error(`[trade] LIQUIDATION FAILED ${exchange}: ${msg}`);
            return { ok: false, message: msg };
          }
        }
        const posKey = `${exchange}:${pair}`;
        const pos = openPositions.get(posKey);
        if (!pos) return { ok: false, message: 'no open position to sell' };
        try {
          const availableBase = await actualBaseBalanceFor(exchange, pair);
          const sellVolume = Math.min(pos.volume, availableBase * 0.995);
          if (!Number.isFinite(sellVolume) || sellVolume <= 0 || sellVolume * meta.snap.bid < 0.01) {
            clearTrackedPosition(posKey, exchange);
            return { ok: false, message: `cleared stale ${pair} position on ${exchange} (no sellable balance)` };
          }
          let txInfo = '';
          if (exchange === 'kraken') {
            const krakenPair = pair.replace('-', '').replace('BTC', 'XBT');
            const result = await placeKrakenOrder({ pair: krakenPair, type: 'sell', ordertype: 'market', volume: sellVolume.toFixed(8) });
            txInfo = `${result.descr.order} txid=${result.txid}`;
          } else if (exchange === 'coinbase') {
            const result = await placeCoinbaseOrder({ productId: pair, side: 'SELL', size: sellVolume.toFixed(8) });
            txInfo = `orderId=${result.order_id}`;
          } else if (exchange === 'binance-us') {
            const symbol = pair.replace('-', '');
            const result = await placeBinanceOrder({ symbol, side: 'SELL', type: 'MARKET', quantity: sellVolume.toFixed(8) });
            txInfo = `orderId=${result.orderId}`;
          }
          const feeRate = exchange === 'kraken' ? KRAKEN_TAKER_FEE : exchange === 'coinbase' ? COINBASE_TAKER_FEE : BINANCE_TAKER_FEE;
          const fee = meta.snap.bid * sellVolume * feeRate;
          const grossPnl = (meta.snap.bid - pos.entryPrice) * sellVolume;
          const netPnl = grossPnl - fee;
          closedTrades.push({
            exchange,
            pair,
            strategyId: pos.strategyId ?? 'restored',
            entryPrice: pos.entryPrice,
            exitPrice: meta.snap.bid,
            volume: sellVolume,
            entryTime: pos.entryTime,
            exitTime: Date.now(),
            grossPnl,
            fee,
            netPnl,
          });
          while (closedTrades.length > 100) closedTrades.shift();
          const todayStart = new Date();
          todayStart.setHours(0, 0, 0, 0);
          dailyPnl = closedTrades
            .filter((trade) => trade.exitTime >= todayStart.getTime())
            .reduce((sum, trade) => sum + trade.netPnl, 0);
          clearTrackedPosition(posKey, exchange);
          lastExitAt.set(`${exchange}:${pair}`, Date.now());
          console.log(`[trade] SOLD ${exchange}:${pair} ${txInfo} net=$${netPnl.toFixed(4)} dayPnL=$${dailyPnl.toFixed(2)}`);
          return { ok: true, message: `sold ${sellVolume.toFixed(8)} on ${exchange} net=$${netPnl.toFixed(4)}` };
        } catch (e) {
          const msg = (e as Error).message;
          if (msg.includes('below minQty') || msg.includes('MIN_NOTIONAL')) {
            clearTrackedPosition(posKey, exchange);
          }
          console.error(`[trade] SELL FAILED ${exchange}: ${msg}`);
          return { ok: false, message: msg };
        }
      }

      // Buy — check available balance on the target exchange
      const price = meta.snap.ask;
      const quoteAsset = quoteAssetForPair(pair);
      let availableQuote = 0;
      try {
        if (exchange === 'kraken') {
          availableQuote = await maybeAutoConvertKrakenQuote(quoteAsset, MAX_POSITION_USD);
        } else if (exchange === 'coinbase') {
          availableQuote = await maybeAutoConvertCoinbaseQuote(quoteAsset, MAX_POSITION_USD);
        } else if (exchange === 'binance-us') {
          availableQuote = await maybeAutoConvertBinanceQuote(quoteAsset, MAX_POSITION_USD);
        }
      } catch {}
      if (availableQuote < MIN_SPENDABLE_QUOTE_USD) {
        try {
          const freed = await maybeLiquidateUntrackedHoldingForFunds(exchange, pair);
          if (freed) {
            lastQuoteBalanceRefresh = 0;
            await refreshSpendableQuoteBalances();
            if (exchange === 'kraken') {
              availableQuote = await maybeAutoConvertKrakenQuote(quoteAsset, MAX_POSITION_USD);
            } else if (exchange === 'coinbase') {
              availableQuote = await maybeAutoConvertCoinbaseQuote(quoteAsset, MAX_POSITION_USD);
            } else if (exchange === 'binance-us') {
              availableQuote = await maybeAutoConvertBinanceQuote(quoteAsset, MAX_POSITION_USD);
            }
          }
        } catch (freeError) {
          console.log(`[trade] FREE FUNDS FAILED ${exchange}: ${(freeError as Error).message}`);
        }
      }
      if (availableQuote < 5) {
        return { ok: false, message: `insufficient ${quoteAsset} on ${exchange} ($${availableQuote.toFixed(2)})` };
      }
      const feeRate = exchange === 'kraken' ? KRAKEN_TAKER_FEE : exchange === 'coinbase' ? COINBASE_TAKER_FEE : BINANCE_TAKER_FEE;
      const spendBudget = Math.min(availableQuote, MAX_POSITION_USD) * Math.max(0.9, 1 - feeRate - 0.02);
      if (spendBudget < 5) {
        return { ok: false, message: `insufficient ${quoteAsset} on ${exchange} ($${availableQuote.toFixed(2)})` };
      }
      const volume = spendBudget / price;

      console.log(`[trade] ATTEMPT BUY ${exchange}:${pair} vol=${volume.toFixed(8)} @ $${price.toFixed(2)}`);
      try {
        let txInfo = '';
        if (exchange === 'kraken') {
          const krakenPair = pair.replace('-', '').replace('BTC', 'XBT');
          const result = await placeKrakenOrder({ pair: krakenPair, type: 'buy', ordertype: 'limit', volume: volume.toFixed(8), price: price.toFixed(2) });
          txInfo = `${result.descr.order} txid=${result.txid}`;
        } else if (exchange === 'coinbase') {
          const result = await placeCoinbaseOrder({ productId: pair, side: 'BUY', size: volume.toFixed(8), limitPrice: String(price) });
          txInfo = `orderId=${result.order_id}`;
        } else if (exchange === 'binance-us') {
          const symbol = pair.replace('-', '');
          const result = await placeBinanceOrder({ symbol, side: 'BUY', type: 'LIMIT', quantity: volume.toFixed(8), price: price.toFixed(2) });
          txInfo = `orderId=${result.orderId}`;
        }
        const posKey = `${exchange}:${pair}`;
        openPositions.set(posKey, {
          pair,
          exchange,
          entryPrice: price,
          volume,
          entryTime: Date.now(),
          highWaterMark: price,
          strategyId: meta.strategy ?? 'composite',
        });
        console.log(`[trade] BUY placed ${exchange}: ${txInfo}`);
        return { ok: true, message: `bought ${volume.toFixed(8)} on ${exchange} @ ${price.toFixed(2)}` };
      } catch (e) {
        const msg = (e as Error).message;
        if (exchange === 'kraken' && msg.includes('Insufficient funds')) {
          lastQuoteBalanceRefresh = 0;
          try {
            await refreshSpendableQuoteBalances();
          } catch {}
        }
        console.error(`[trade] BUY FAILED ${exchange}: ${msg}`);
        return { ok: false, message: msg };
      }
    },
  };
}

export const cryptoTradeSource: Source<TradeItem> = makeCryptoTradeSource();
export { runBacktest } from './analysis/backtest.js';
export { computeBacktestMetrics } from './analysis/analytics.js';
