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
 *   - $5/day max loss limit (5% of $100)
 *   - $100 max position size
 */

import type { Source, MarketSnapshot, Opportunity, ActionResult, PriceFeed } from '@b1dz/core';
import {
  KrakenFeed, CoinbaseFeed, BinanceUsFeed,
  placeOrder as placeKrakenOrder,
  placeCoinbaseOrder,
  placeBinanceOrder,
  getBalance as getKrakenBalance,
  getCoinbaseBalance,
  getBinanceBalance,
  getCoinbaseFills,
  getBinanceTrades,
  MAX_POSITION_USD, KRAKEN_TAKER_FEE, COINBASE_TAKER_FEE, BINANCE_TAKER_FEE,
  getActivePairs,
} from '@b1dz/source-crypto-arb';

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

/** Max daily loss before halting trades. */
const DAILY_LOSS_LIMIT_USD = 5;
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

interface Position {
  pair: string;
  exchange: string;
  entryPrice: number;
  volume: number;
  entryTime: number;
  highWaterMark: number; // highest price seen since entry
}
const openPositions = new Map<string, Position>();

/** One position per exchange — check if THIS exchange already has a position. */
function hasPositionOnExchange(exchange: string): boolean {
  for (const pos of openPositions.values()) {
    if (pos.exchange === exchange) return true;
  }
  return exchangesHoldingCrypto.has(exchange);
}

/** Set by hydration — exchanges that have non-trivial crypto holdings. */
const exchangesHoldingCrypto = new Set<string>();

/** Pending buy — set in evaluate(), cleared in act(). Prevents multiple buys in same tick. */
let pendingBuyExchange: string | null = null;

/** Timestamp of last trade close per pair. */
const lastExitAt = new Map<string, number>();

/** Cumulative realized P/L for today. */
let dailyPnl = 0;
let dailyPnlDate = new Date().toDateString();
let tradePollCount = 0;

/** Whether we've hydrated from exchange APIs yet. */
const hydratedExchanges = new Set<string>();

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
  exchangesHoldingCrypto.add(exchange);
  console.log(`[trade] RESTORED from exchange: ${exchange}:${pair} ${volume} @ $${entryPrice.toFixed(2)} (${reason})`);
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

async function hydrateKrakenPositions(): Promise<void> {
  const { getBalance, getTradeHistory } = await import('@b1dz/source-crypto-arb');
  const balance = await getBalance();
  const tradeHistory = await getTradeHistory();
  const holdings = findNonStableHoldings(balance);
  if (holdings.length === 0) return;

  console.log(`[trade] found ${holdings.length} crypto holdings on kraken — blocking new kraken trades until resolved`);

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
      continue;
    }
    const entryPrice = parseFloat(buyTrade.price);
    if (!isFinite(entryPrice) || entryPrice <= 0) continue;
    restorePosition('kraken', pair, holding.amount, entryPrice, buyTrade.time * 1000, 'from trade history');
  }

  // Preserve the existing daily P/L reconstruction from Kraken fills.
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayTs = todayStart.getTime() / 1000;
  const todayTrades = trades.filter((trade) => trade.time >= todayTs);
  const buysByPair = new Map<string, { cost: number; fee: number }>();
  let todayPnl = 0;
  for (const trade of [...todayTrades].reverse()) {
    const cost = parseFloat(trade.cost);
    const fee = parseFloat(trade.fee);
    if (trade.type === 'buy') {
      buysByPair.set(trade.pair, { cost, fee });
    } else if (trade.type === 'sell') {
      const buy = buysByPair.get(trade.pair);
      if (!buy) continue;
      todayPnl += (cost - buy.cost) - fee - buy.fee;
      buysByPair.delete(trade.pair);
    }
  }
  dailyPnl = todayPnl;
  if (todayTrades.length > 0) {
    console.log(`[trade] today: ${todayTrades.length} kraken trades, realized P/L: $${dailyPnl.toFixed(2)}, ${openPositions.size} open positions`);
  }
}

async function hydrateCoinbasePositions(): Promise<void> {
  const balance = await getCoinbaseBalance();
  const fills = (await getCoinbaseFills(200)).sort((a, b) => Date.parse(b.trade_time) - Date.parse(a.trade_time));
  const holdings = findNonStableHoldings(balance);
  if (holdings.length === 0) return;

  console.log(`[trade] found ${holdings.length} crypto holdings on coinbase — blocking new coinbase trades until resolved`);
  exchangesHoldingCrypto.add('coinbase');

  for (const holding of holdings) {
    const pair = `${holding.asset}-USD`;
    const buyFill = fills.find((fill) => fill.side.toUpperCase() === 'BUY' && fill.product_id === pair);
    if (!buyFill) {
      console.log(`[trade] holding coinbase:${pair}=${holding.amount} but no buy fill found in history`);
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

  console.log(`[trade] found ${holdings.length} crypto holdings on binance-us — blocking new binance-us trades until resolved`);
  exchangesHoldingCrypto.add('binance-us');

  for (const holding of holdings) {
    const pair = `${holding.asset}-USD`;
    const symbol = pair.replace('-', '');
    const trades = (await getBinanceTrades(symbol, 1000)).sort((a, b) => b.time - a.time);
    const buyTrade = trades.find((trade) => trade.isBuyer);
    if (!buyTrade) {
      console.log(`[trade] holding binance-us:${pair}=${holding.amount} but no buy trade found in history`);
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

  if (hydratedExchanges.size === 0) {
    exchangesHoldingCrypto.clear();
  }

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

  if (hydratedExchanges.size === steps.length && openPositions.size === 0 && exchangesHoldingCrypto.size === 0) {
    console.log('[trade] no crypto holdings found — starting clean');
  }
}

/** Serialize positions/cooldowns/dailyPnl for persistence. */
export function serializeTradeState(): Record<string, unknown> {
  return {
    positions: [...openPositions.values()],
    exits: [...lastExitAt.entries()].map(([pair, at]) => ({ pair, at })),
    dailyPnl,
    dailyPnlDate,
  };
}

function resetDailyPnlIfNeeded() {
  const today = new Date().toDateString();
  if (today !== dailyPnlDate) {
    dailyPnl = 0;
    dailyPnlDate = today;
  }
}

function isDailyLossLimitHit(): boolean {
  resetDailyPnlIfNeeded();
  return dailyPnl <= -DAILY_LOSS_LIMIT_USD;
}

/** Live status snapshot for TUI display. */
export interface TradeStatus {
  positions: { exchange: string; pair: string; entryPrice: number; volume: number; pnlPct: number; stopPrice: number; elapsed: string }[];
  position: { pair: string; entryPrice: number; volume: number; pnlPct: number; stopPrice: number; elapsed: string } | null;
  dailyPnl: number;
  dailyLossLimitHit: boolean;
  cooldowns: { pair: string; remainingSec: number }[];
  pairsScanned: number;
  ticksPerPair: Record<string, number>;
  exchangeStates: { exchange: string; readyPairs: number; warmingPairs: number; openPositions: number; blockedReason: string | null }[];
  lastSignal: string | null;
}

export function getTradeStatus(): TradeStatus {
  resetDailyPnlIfNeeded();
  const positions = [...openPositions.values()].map((pos) => ({
    exchange: pos.exchange,
    pair: pos.pair,
    entryPrice: pos.entryPrice,
    volume: pos.volume,
    pnlPct: 0,
    stopPrice: trailingStopPrice(pos),
    elapsed: `${Math.floor((Date.now() - pos.entryTime) / 60000)}m`,
  }));
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
    const blockedReason = exchangesHoldingCrypto.has(exchange)
      ? 'holding crypto'
      : openCount > 0
        ? 'open position'
        : null;
    return { exchange, readyPairs, warmingPairs, openPositions: openCount, blockedReason };
  });

  return {
    positions,
    position: pos,
    dailyPnl,
    dailyLossLimitHit: isDailyLossLimitHit(),
    cooldowns,
    pairsScanned: histories.size,
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
      // Restore positions from exchange APIs on first tick (source of truth)
      await hydrateFromExchange();
      tradePollCount++;

      const PAIRS = await getActivePairs();
      const items: TradeItem[] = [];
      // Poll each pair on each exchange — one position per exchange
      for (const { feed, exchange } of TRADE_FEEDS) {
        for (const pair of PAIRS) {
          const snap = await feed.snapshot(pair);
          if (!snap) continue;
          if (!isFinite(snap.bid) || !isFinite(snap.ask) || snap.bid <= 0 || snap.ask <= 0) continue;
          const histKey = `${exchange}:${pair}`;
          const hist = histories.get(histKey) ?? [];
          hist.push(snap);
          while (hist.length > 200) hist.shift();
          histories.set(histKey, hist);
          items.push({ pair, exchange, snap, history: [...hist] });

          // Update high water mark for open positions
          const posKey = `${exchange}:${pair}`;
          const pos = openPositions.get(posKey);
          if (pos && snap.bid > pos.highWaterMark) {
            pos.highWaterMark = snap.bid;
          }

          // Verbose raw logs should reflect every tick and warmup state.
          if (pos) {
            const pnlPct = ((snap.bid - pos.entryPrice) / pos.entryPrice) * 100;
            const stopPct = ((trailingStopPrice(pos) - pos.entryPrice) / pos.entryPrice) * 100;
            console.log(`[trade] ${exchange}:${pair} $${snap.bid.toFixed(2)} pos:${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(3)}% stop:${stopPct >= 0 ? '+' : ''}${stopPct.toFixed(3)}%`);
          } else if (hist.length < WARMUP_TICKS) {
            console.log(`[trade] ${exchange}:${pair} $${snap.bid.toFixed(2)} warming ${hist.length}/${WARMUP_TICKS}`);
          } else {
            console.log(`[trade] ${exchange}:${pair} $${snap.bid.toFixed(2)} ready ticks=${hist.length}`);
          }
        }
      }
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

      // ── Check exits first ──
      const posKey = `${item.exchange}:${item.pair}`;
      const pos = openPositions.get(posKey);
      if (pos) {
        const pnlPct = (item.snap.bid - pos.entryPrice) / pos.entryPrice;
        const stopPrice = trailingStopPrice(pos);
        const elapsed = Date.now() - pos.entryTime;

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
          const sig = activeStrategy.evaluate(item.snap, item.history);
          if (sig?.side === 'sell' && sig.strength >= 0.8) {
            exitReason = `strategy sell: ${sig.reason}`;
          }
        }

        if (exitReason) {
          const sellFee = item.snap.bid * pos.volume * KRAKEN_TAKER_FEE;
          const grossPnl = (item.snap.bid - pos.entryPrice) * pos.volume;
          const netPnl = grossPnl - sellFee;
          console.log(`[trade] EXIT ${item.pair}: ${exitReason} gross=$${grossPnl.toFixed(4)} net=$${netPnl.toFixed(4)}`);
          return {
            id: `crypto-trade:${item.exchange}:${item.pair}:sell:${Date.now()}`,
            sourceId: `crypto-trade:${item.exchange}:${strategyId}`,
            externalId: `${item.pair}:sell:${Date.now()}`,
            title: `SELL ${item.pair} @ ${item.snap.bid.toFixed(2)} — ${exitReason}`,
            category: 'crypto-trade',
            costNow: 0,
            projectedReturn: item.snap.bid * pos.volume,
            projectedProfit: netPnl,
            confidence: 1,
            metadata: { strategy: strategyId, signal: { side: 'sell' as const, strength: 1, reason: exitReason }, snap: item.snap, position: pos },
            createdAt: Date.now(),
            updatedAt: Date.now(),
          };
        }
        return null; // hold position
      }

      // ── Check entries ──

      // Daily loss limit
      if (isDailyLossLimitHit()) {
        if (item.history.length % 20 === 0) {
          console.log(`[trade] ${item.pair} daily loss limit hit ($${dailyPnl.toFixed(2)}), no new trades today`);
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
      if (hasPositionOnExchange(tradeExchange)) return null;
      if (pendingBuyExchange === tradeExchange) return null;

      // Already have a position for this pair on this exchange
      const posKey2 = `${tradeExchange}:${item.pair}`;
      if (openPositions.has(posKey2)) return null;

      // Run strategy
      const sig = activeStrategy.evaluate(item.snap, item.history);
      if (!sig || sig.side !== 'buy') return null;
      if (sig.strength < 0.7) return null;

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
      console.log(`[trade] ENTRY SIGNAL ${item.pair} @ $${price.toFixed(2)}: ${sig.reason} (str=${sig.strength.toFixed(2)})`);
      return {
        id: `crypto-trade:${item.exchange}:${item.pair}:buy:${Date.now()}`,
        sourceId: `crypto-trade:${item.exchange}:${strategyId}`,
        externalId: `${item.pair}:buy:${Date.now()}`,
        title: `BUY ${item.pair} @ ${price.toFixed(2)} — ${sig.reason}`,
        category: 'crypto-trade',
        costNow: price,
        projectedReturn: price * (1 + TAKE_PROFIT_PCT),
        projectedProfit: price * netTakeProfit,
        confidence: sig.strength,
        metadata: { strategy: strategyId, signal: sig, snap: item.snap },
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
    },

    async act(opp): Promise<ActionResult> {
      const meta = opp.metadata as unknown as { signal: Signal; snap: MarketSnapshot; position?: Position };
      const pair = meta.snap.pair;
      const exchange = meta.snap.exchange;
      pendingBuyExchange = null;

      if (meta.signal.side === 'sell') {
        const posKey = `${exchange}:${pair}`;
        const pos = openPositions.get(posKey);
        if (!pos) return { ok: false, message: 'no open position to sell' };
        try {
          let txInfo = '';
          if (exchange === 'kraken') {
            const krakenPair = pair.replace('-', '').replace('BTC', 'XBT');
            const result = await placeKrakenOrder({ pair: krakenPair, type: 'sell', ordertype: 'market', volume: pos.volume.toFixed(8) });
            txInfo = `${result.descr.order} txid=${result.txid}`;
          } else if (exchange === 'coinbase') {
            const result = await placeCoinbaseOrder({ productId: pair, side: 'SELL', size: pos.volume.toFixed(8) });
            txInfo = `orderId=${result.order_id}`;
          } else if (exchange === 'binance-us') {
            const symbol = pair.replace('-', '');
            const result = await placeBinanceOrder({ symbol, side: 'SELL', type: 'MARKET', quantity: pos.volume.toFixed(8) });
            txInfo = `orderId=${result.orderId}`;
          }
          const feeRate = exchange === 'kraken' ? KRAKEN_TAKER_FEE : exchange === 'coinbase' ? COINBASE_TAKER_FEE : BINANCE_TAKER_FEE;
          const fee = meta.snap.bid * pos.volume * feeRate;
          const grossPnl = (meta.snap.bid - pos.entryPrice) * pos.volume;
          const netPnl = grossPnl - fee;
          resetDailyPnlIfNeeded();
          dailyPnl += netPnl;
          openPositions.delete(posKey);
          const stillHolding = [...openPositions.values()].some((p) => p.exchange === exchange);
          if (!stillHolding) exchangesHoldingCrypto.delete(exchange);
          lastExitAt.set(`${exchange}:${pair}`, Date.now());
          console.log(`[trade] SOLD ${exchange}:${pair} ${txInfo} net=$${netPnl.toFixed(4)} dayPnL=$${dailyPnl.toFixed(2)}`);
          return { ok: true, message: `sold ${pos.volume.toFixed(8)} on ${exchange} net=$${netPnl.toFixed(4)}` };
        } catch (e) {
          console.error(`[trade] SELL FAILED ${exchange}: ${(e as Error).message}`);
          return { ok: false, message: (e as Error).message };
        }
      }

      // Buy — check available balance on the target exchange
      const price = meta.snap.ask;
      let availableUsd = 0;
      try {
        if (exchange === 'kraken') {
          const bal = await getKrakenBalance();
          availableUsd = Math.min(parseFloat(bal.ZUSD ?? '0') * 0.995, 99.50);
        } else if (exchange === 'coinbase') {
          const bal = await getCoinbaseBalance();
          availableUsd = Math.min(
            (parseFloat(bal.USD ?? '0') + parseFloat(bal.USDC ?? '0')) * 0.995,
            99.50,
          );
        } else if (exchange === 'binance-us') {
          const bal = await getBinanceBalance();
          availableUsd = Math.min(
            (parseFloat(bal.USD ?? '0') + parseFloat(bal.USDC ?? '0') + parseFloat(bal.USDT ?? '0')) * 0.995,
            99.50,
          );
        }
      } catch {}
      if (availableUsd < 5) {
        return { ok: false, message: `insufficient funds on ${exchange} ($${availableUsd.toFixed(2)})` };
      }
      const volume = availableUsd / price;

      console.log(`[trade] EXECUTE BUY ${exchange}:${pair} vol=${volume.toFixed(8)} @ $${price.toFixed(2)}`);
      try {
        let txInfo = '';
        if (exchange === 'kraken') {
          const krakenPair = pair.replace('-', '').replace('BTC', 'XBT');
          const result = await placeKrakenOrder({ pair: krakenPair, type: 'buy', ordertype: 'limit', volume: volume.toFixed(8), price: price.toFixed(2) });
          txInfo = `${result.descr.order} txid=${result.txid}`;
        } else if (exchange === 'coinbase') {
          const result = await placeCoinbaseOrder({ productId: pair, side: 'BUY', size: volume.toFixed(8), limitPrice: price.toFixed(2) });
          txInfo = `orderId=${result.order_id}`;
        } else if (exchange === 'binance-us') {
          const symbol = pair.replace('-', '');
          const result = await placeBinanceOrder({ symbol, side: 'BUY', type: 'LIMIT', quantity: volume.toFixed(8), price: price.toFixed(2) });
          txInfo = `orderId=${result.orderId}`;
        }
        const posKey = `${exchange}:${pair}`;
        openPositions.set(posKey, { pair, exchange, entryPrice: price, volume, entryTime: Date.now(), highWaterMark: price });
        console.log(`[trade] BUY placed ${exchange}: ${txInfo}`);
        return { ok: true, message: `bought ${volume.toFixed(8)} on ${exchange} @ ${price.toFixed(2)}` };
      } catch (e) {
        console.error(`[trade] BUY FAILED ${exchange}: ${(e as Error).message}`);
        return { ok: false, message: (e as Error).message };
      }
    },
  };
}

export const cryptoTradeSource: Source<TradeItem> = makeCryptoTradeSource();
