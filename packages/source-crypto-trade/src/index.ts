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
import { KrakenFeed, placeOrder, MAX_POSITION_USD, KRAKEN_TAKER_FEE } from '@b1dz/source-crypto-arb';

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
  snap: MarketSnapshot;
  history: MarketSnapshot[];
}

// ─── Exit parameters ───────────────────────────────────────────

/** Take-profit target. */
const TAKE_PROFIT_PCT = 0.015;  // +1.5%

/** Initial stop-loss. */
const INITIAL_STOP_PCT = 0.005; // -0.5%

/** Move stop to breakeven when position reaches this profit. */
const BREAKEVEN_TRIGGER_PCT = 0.003; // +0.3%

/** Lock in profit: move stop to this level when position reaches LOCK_TRIGGER. */
const LOCK_TRIGGER_PCT = 0.008;  // +0.8%
const LOCK_STOP_PCT = 0.005;     // stop at +0.5%

/** Close at market if position has been open this long and is flat. */
const TIME_EXIT_MS = 30 * 60 * 1000; // 30 minutes
const TIME_EXIT_FLAT_PCT = 0.001; // ±0.1%

/** Cooldown after closing a position before opening another. */
const COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes

/** Max daily loss before halting trades. */
const DAILY_LOSS_LIMIT_USD = 5;

// ─── State ─────────────────────────────────────────────────────

const PAIRS = ['BTC-USD', 'ETH-USD'];
const feed: PriceFeed = new KrakenFeed();
const histories = new Map<string, MarketSnapshot[]>();

interface Position {
  pair: string;
  entryPrice: number;
  volume: number;
  entryTime: number;
  highWaterMark: number; // highest price seen since entry
}
const openPositions = new Map<string, Position>();

/** Timestamp of last trade close per pair. */
const lastExitAt = new Map<string, number>();

/** Cumulative realized P/L for today. */
let dailyPnl = 0;
let dailyPnlDate = new Date().toDateString();

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

// Import the multi-signal strategy dynamically to avoid circular deps
let defaultStrategy: Strategy | null = null;
async function getDefaultStrategy(): Promise<Strategy> {
  if (!defaultStrategy) {
    const mod = await import('./strategies.js');
    defaultStrategy = mod.multiSignalStrategy;
  }
  return defaultStrategy;
}

export function makeCryptoTradeSource(strategy?: Strategy): Source<TradeItem> {
  const strategyId = strategy?.id ?? 'multi-signal';

  return {
    id: `crypto-trade:kraken:${strategyId}`,
    pollIntervalMs: 5000,

    async poll() {
      const items: TradeItem[] = [];
      for (const pair of PAIRS) {
        const snap = await feed.snapshot(pair);
        if (!snap) continue;
        const hist = histories.get(pair) ?? [];
        hist.push(snap);
        while (hist.length > 200) hist.shift();
        histories.set(pair, hist);
        items.push({ pair, snap, history: [...hist] });

        // Update high water mark for open positions
        const pos = openPositions.get(pair);
        if (pos && snap.bid > pos.highWaterMark) {
          pos.highWaterMark = snap.bid;
        }

        // Log current state
        if (pos) {
          const pnlPct = ((snap.bid - pos.entryPrice) / pos.entryPrice) * 100;
          const stopPrice = trailingStopPrice(pos);
          const stopPct = ((stopPrice - pos.entryPrice) / pos.entryPrice) * 100;
          console.log(`[trade] ${pair} $${snap.bid.toFixed(2)} pos:${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(3)}% stop:${stopPct >= 0 ? '+' : ''}${stopPct.toFixed(3)}%`);
        } else {
          console.log(`[trade] ${pair} $${snap.bid.toFixed(2)} (no position) ticks=${hist.length}`);
        }
      }
      return items;
    },

    evaluate(item): Opportunity | null {
      const activeStrategy = strategy ?? defaultStrategy ?? momentumStrategy;

      // ── Check exits first ──
      const pos = openPositions.get(item.pair);
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
            id: `crypto-trade:kraken:${item.pair}:sell:${Date.now()}`,
            sourceId: `crypto-trade:kraken:${strategyId}`,
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

      // Already have a position for this pair
      if (openPositions.has(item.pair)) return null;

      // Run strategy
      const sig = activeStrategy.evaluate(item.snap, item.history);
      if (!sig || sig.side !== 'buy') return null;
      if (sig.strength < 0.75) return null;

      // Check profitability: need to clear round-trip fees with take-profit
      const roundTripFee = 2 * KRAKEN_TAKER_FEE; // 0.52%
      const netTakeProfit = TAKE_PROFIT_PCT - roundTripFee;
      if (netTakeProfit <= 0) {
        console.log(`[trade] ${item.pair} take-profit ${(TAKE_PROFIT_PCT * 100).toFixed(1)}% won't cover fees ${(roundTripFee * 100).toFixed(2)}%`);
        return null;
      }

      const price = item.snap.ask;
      console.log(`[trade] ENTRY SIGNAL ${item.pair} @ $${price.toFixed(2)}: ${sig.reason} (str=${sig.strength.toFixed(2)})`);
      return {
        id: `crypto-trade:kraken:${item.pair}:buy:${Date.now()}`,
        sourceId: `crypto-trade:kraken:${strategyId}`,
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
      const krakenPair = pair.replace('-', '').replace('BTC', 'XBT');

      if (meta.signal.side === 'sell') {
        const pos = openPositions.get(pair);
        if (!pos) return { ok: false, message: 'no open position to sell' };
        try {
          const result = await placeOrder({
            pair: krakenPair,
            type: 'sell',
            ordertype: 'market',
            volume: pos.volume.toFixed(8),
          });
          const grossPnl = (meta.snap.bid - pos.entryPrice) * pos.volume;
          const fee = meta.snap.bid * pos.volume * KRAKEN_TAKER_FEE;
          const netPnl = grossPnl - fee;

          // Track daily P/L
          resetDailyPnlIfNeeded();
          dailyPnl += netPnl;

          openPositions.delete(pair);
          lastExitAt.set(pair, Date.now());
          console.log(`[trade] SOLD ${pair}: ${result.descr.order} txid=${result.txid} net=$${netPnl.toFixed(4)} dayPnL=$${dailyPnl.toFixed(2)}`);
          return { ok: true, message: `sold ${pos.volume.toFixed(8)} net=$${netPnl.toFixed(4)}` };
        } catch (e) {
          console.error(`[trade] SELL FAILED: ${(e as Error).message}`);
          return { ok: false, message: (e as Error).message };
        }
      }

      // Buy
      const price = meta.snap.ask;
      const volume = Math.min(MAX_POSITION_USD, 100) / price;

      console.log(`[trade] EXECUTE BUY ${pair}: vol=${volume.toFixed(8)} @ $${price.toFixed(2)}`);
      try {
        const result = await placeOrder({
          pair: krakenPair,
          type: 'buy',
          ordertype: 'limit',
          volume: volume.toFixed(8),
          price: price.toFixed(2),
        });
        openPositions.set(pair, {
          pair,
          entryPrice: price,
          volume,
          entryTime: Date.now(),
          highWaterMark: price,
        });
        console.log(`[trade] BUY placed: ${result.descr.order} txid=${result.txid}`);
        return { ok: true, message: `bought ${volume.toFixed(8)} @ ${price.toFixed(2)}` };
      } catch (e) {
        console.error(`[trade] BUY FAILED: ${(e as Error).message}`);
        return { ok: false, message: (e as Error).message };
      }
    },
  };
}

export const cryptoTradeSource: Source<TradeItem> = makeCryptoTradeSource();
