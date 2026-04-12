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

/** Whether we've hydrated from exchange APIs yet. */
let hydrated = false;

/**
 * Reconstruct positions from EXCHANGE data (source of truth).
 * Checks Kraken balance for non-USD holdings and recent trade history
 * to figure out what we're holding and at what entry price.
 */
async function hydrateFromExchange() {
  if (hydrated) return;
  hydrated = true;

  try {
    const { getBalance, getTradeHistory } = await import('@b1dz/source-crypto-arb');
    const balance = await getBalance();
    const tradeHistory = await getTradeHistory();

    // Find non-trivial crypto holdings (not USD/stablecoins)
    const stables = new Set(['ZUSD', 'USDC', 'USDT', 'USD']);
    const holdings: { asset: string; amount: number }[] = [];
    for (const [asset, val] of Object.entries(balance)) {
      const amount = parseFloat(val);
      if (amount > 0.0001 && !stables.has(asset)) {
        holdings.push({ asset, amount });
      }
    }

    if (holdings.length === 0) {
      console.log('[trade] no crypto holdings found — starting clean');
      exchangesHoldingCrypto.clear();
      return;
    }
    // We're holding crypto on Kraken — block new trades on Kraken until resolved
    exchangesHoldingCrypto.add('kraken');
    console.log(`[trade] found ${holdings.length} crypto holdings on kraken — blocking new kraken trades until resolved`);

    // Map Kraken asset names to pair names
    const assetToPair: Record<string, string> = { XXBT: 'BTC-USD', XETH: 'ETH-USD', XZEC: 'ZEC-USD', XXRP: 'XRP-USD', XXLM: 'XLM-USD', XXMR: 'XMR-USD', XXDG: 'DOGE-USD' };
    // Any asset not in the map — use asset name directly
    for (const [asset] of Object.entries(balance)) {
      if (!assetToPair[asset] && !stables.has(asset)) {
        assetToPair[asset] = `${asset}-USD`;
      }
    }

    // Look through recent trades to find the entry price for each holding
    const trades = Object.values(tradeHistory).sort((a, b) => b.time - a.time);

    for (const h of holdings) {
      const pair = assetToPair[h.asset];
      if (!pair) continue;
      const base = pair.replace('-USD', '');

      // Find the most recent BUY trade for this pair — match flexibly
      const buyTrade = trades.find((t) => {
        if (t.type !== 'buy') return false;
        const tp = t.pair.toUpperCase();
        return tp.includes(base.toUpperCase()) && tp.includes('USD');
      });

      const entryPrice = buyTrade ? parseFloat(buyTrade.price) : 0;
      const entryTime = buyTrade ? buyTrade.time * 1000 : Date.now();

      if (entryPrice > 0) {
        openPositions.set(pair, {
          pair,
          exchange: 'kraken',
          entryPrice,
          volume: h.amount,
          entryTime,
          highWaterMark: entryPrice,
        });
        console.log(`[trade] RESTORED from exchange: ${pair} ${h.amount} @ $${entryPrice.toFixed(2)} (${buyTrade ? 'from trade history' : 'unknown entry'})`);
      } else {
        console.log(`[trade] holding ${pair}=${h.amount} but no buy trade found in history — can't determine entry`);
      }
    }

    // Calculate today's realized P/L — only matched buy+sell round-trips
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayTs = todayStart.getTime() / 1000;
    const todayTrades = trades.filter((t) => t.time >= todayTs);
    const buysByPair = new Map<string, { cost: number; fee: number }>();
    let todayPnl = 0;
    for (const t of [...todayTrades].reverse()) { // oldest first
      const cost = parseFloat(t.cost);
      const fee = parseFloat(t.fee);
      if (t.type === 'buy') {
        buysByPair.set(t.pair, { cost, fee });
      } else if (t.type === 'sell') {
        const buy = buysByPair.get(t.pair);
        if (buy) {
          todayPnl += (cost - buy.cost) - fee - buy.fee;
          buysByPair.delete(t.pair);
        }
      }
    }
    dailyPnl = todayPnl;
    if (todayTrades.length > 0) {
      console.log(`[trade] today: ${todayTrades.length} trades, realized P/L: $${dailyPnl.toFixed(2)}, ${openPositions.size} open positions`);
    }
  } catch (e) {
    console.error(`[trade] exchange hydration failed: ${(e as Error).message}`);
    // Fall back — start clean, daemon will pick up on next trade
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
  position: { pair: string; entryPrice: number; volume: number; pnlPct: number; stopPrice: number; elapsed: string } | null;
  dailyPnl: number;
  dailyLossLimitHit: boolean;
  cooldowns: { pair: string; remainingSec: number }[];
  pairsScanned: number;
  ticksPerPair: Record<string, number>;
  lastSignal: string | null;
}

export function getTradeStatus(): TradeStatus {
  resetDailyPnlIfNeeded();
  const pos = openPositions.size > 0 ? [...openPositions.values()][0] : null;
  const cooldowns: { pair: string; remainingSec: number }[] = [];
  for (const [pair, exitTime] of lastExitAt) {
    const remaining = Math.max(0, COOLDOWN_MS - (Date.now() - exitTime));
    if (remaining > 0) cooldowns.push({ pair, remainingSec: Math.ceil(remaining / 1000) });
  }
  const ticksPerPair: Record<string, number> = {};
  for (const [pair, hist] of histories) ticksPerPair[pair] = hist.length;

  return {
    position: pos ? {
      pair: pos.pair,
      entryPrice: pos.entryPrice,
      volume: pos.volume,
      pnlPct: 0, // will be filled by caller with current price
      stopPrice: trailingStopPrice(pos),
      elapsed: `${Math.floor((Date.now() - pos.entryTime) / 60000)}m`,
    } : null,
    dailyPnl,
    dailyLossLimitHit: isDailyLossLimitHit(),
    cooldowns,
    pairsScanned: histories.size,
    ticksPerPair,
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

      const PAIRS = await getActivePairs();
      const items: TradeItem[] = [];
      // Poll each pair on each exchange — one position per exchange
      for (const { feed, exchange } of TRADE_FEEDS) {
        for (const pair of PAIRS) {
          const snap = await feed.snapshot(pair);
          if (!snap) continue;
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

          // Log current state (only every 5th tick to reduce noise)
          if (hist.length % 5 === 0) {
            if (pos) {
              const pnlPct = ((snap.bid - pos.entryPrice) / pos.entryPrice) * 100;
              const stopPct = ((trailingStopPrice(pos) - pos.entryPrice) / pos.entryPrice) * 100;
              console.log(`[trade] ${exchange}:${pair} $${snap.bid.toFixed(2)} pos:${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(3)}% stop:${stopPct >= 0 ? '+' : ''}${stopPct.toFixed(3)}%`);
            } else {
              console.log(`[trade] ${exchange}:${pair} $${snap.bid.toFixed(2)} ticks=${hist.length}`);
            }
          }
        }
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
