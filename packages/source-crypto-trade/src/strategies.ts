/**
 * Trading strategies for single-exchange (Kraken) crypto trading.
 *
 * Two strategies:
 *   1. multiSignalStrategy — RSI + EMA + mean reversion (swing trades)
 *   2. scalpStrategy — quick dip-buy / bounce-sell (high frequency)
 *
 * The composite strategy runs both and takes whichever fires first.
 */

import type { MarketSnapshot } from '@b1dz/core';

interface Signal {
  side: 'buy' | 'sell';
  strength: number;
  reason: string;
}

interface Strategy {
  id: string;
  evaluate(snap: MarketSnapshot, history: MarketSnapshot[]): Signal | null;
}

const FIFTEEN_MIN_TICKS = 180;
const SIDEWAYS_MIN_TICKS = 60;
const SIDEWAYS_MAX_RANGE_PCT = 1.2;
const SIDEWAYS_MAX_DRIFT_PCT = 0.45;
const SIDEWAYS_STRONG_BUY_THRESHOLD = 0.85;

export interface TrendRegime {
  regime: 'sideways' | 'trending';
  rangePct: number;
  driftPct: number;
}

// ─── Indicator helpers ─────────────────────────────────────────

function ema(values: number[], period: number): number[] {
  if (values.length === 0) return [];
  const k = 2 / (period + 1);
  const result = [values[0]];
  for (let i = 1; i < values.length; i++) {
    result.push(values[i] * k + result[i - 1] * (1 - k));
  }
  return result;
}

function sma(values: number[], period: number): number {
  if (values.length < period) return values.reduce((a, b) => a + b, 0) / values.length;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

function rsi(prices: number[], period = 14): number {
  if (prices.length < period + 1) return 50;
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const change = prices[i] - prices[i - 1];
    if (change > 0) avgGain += change;
    else avgLoss -= change;
  }
  avgGain /= period;
  avgLoss /= period;
  for (let i = period + 1; i < prices.length; i++) {
    const change = prices[i] - prices[i - 1];
    avgGain = (avgGain * (period - 1) + (change > 0 ? change : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (change < 0 ? -change : 0)) / period;
  }
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

function spreadPct(snap: MarketSnapshot): number {
  const mid = (snap.bid + snap.ask) / 2;
  return ((snap.ask - snap.bid) / mid) * 100;
}

export function analyze15mTrend(history: MarketSnapshot[]): TrendRegime {
  const window = history.slice(-FIFTEEN_MIN_TICKS);
  if (window.length < SIDEWAYS_MIN_TICKS) {
    return { regime: 'trending', rangePct: Infinity, driftPct: Infinity };
  }

  const bids = window.map((snap) => snap.bid).filter((bid) => Number.isFinite(bid) && bid > 0);
  if (bids.length < SIDEWAYS_MIN_TICKS) {
    return { regime: 'trending', rangePct: Infinity, driftPct: Infinity };
  }

  const high = Math.max(...bids);
  const low = Math.min(...bids);
  const mid = (high + low) / 2;
  const first = bids[0]!;
  const last = bids[bids.length - 1]!;
  const rangePct = mid > 0 ? ((high - low) / mid) * 100 : Infinity;
  const driftPct = first > 0 ? Math.abs((last - first) / first) * 100 : Infinity;

  return {
    regime: rangePct <= SIDEWAYS_MAX_RANGE_PCT && driftPct <= SIDEWAYS_MAX_DRIFT_PCT ? 'sideways' : 'trending',
    rangePct,
    driftPct,
  };
}

export function apply15mTrendFilter(signal: Signal | null, snap: MarketSnapshot, history: MarketSnapshot[]): Signal | null {
  if (!signal || signal.side !== 'buy') return signal;
  const regime = analyze15mTrend(history);
  if (regime.regime !== 'sideways') return signal;
  if (signal.strength >= SIDEWAYS_STRONG_BUY_THRESHOLD) {
    console.log(`[trend] ${snap.pair} 15m sideways but allowing strong buy str=${signal.strength.toFixed(2)} range=${regime.rangePct.toFixed(2)}% drift=${regime.driftPct.toFixed(2)}%`);
    return signal;
  }
  console.log(`[trend] ${snap.pair} 15m sideways, suppress buy str=${signal.strength.toFixed(2)} range=${regime.rangePct.toFixed(2)}% drift=${regime.driftPct.toFixed(2)}%`);
  return null;
}

// ─── Multi-Signal Strategy (loosened thresholds) ───────────────

export const multiSignalStrategy: Strategy = {
  id: 'multi-signal',
  evaluate(snap: MarketSnapshot, history: MarketSnapshot[]): Signal | null {
    if (history.length < 20) return null; // lowered from 30

    const bids = history.map((s) => s.bid);
    const currentRsi = rsi(bids);
    const prevRsi = rsi(bids.slice(0, -1));

    const ema8 = ema(bids, 8);
    const ema21 = ema(bids, 21);
    const fastNow = ema8[ema8.length - 1];
    const slowNow = ema21[ema21.length - 1];
    const fastPrev = ema8[ema8.length - 2];
    const slowPrev = ema21[ema21.length - 2];

    const avg50 = sma(bids, Math.min(50, bids.length));
    const priceDeviation = (snap.bid - avg50) / avg50;

    const currentSpread = spreadPct(snap);
    const avgSpread = sma(history.slice(-20).map((s) => spreadPct(s)), 20);
    const spreadOk = currentSpread <= avgSpread * 2; // loosened from 1.5x

    // ── BUY signals (loosened) ──
    const rsiBounce = prevRsi < 35 && currentRsi >= 35; // was 30
    const rsiBuyZone = currentRsi < 45; // was 40
    const emaBullCross = fastPrev <= slowPrev && fastNow > slowNow;
    const emaBullish = fastNow > slowNow;
    const belowAvg = priceDeviation < -0.002; // was -0.003 (0.2% below avg)

    let buyStrength = 0;
    let buyReason = '';

    if (rsiBounce && spreadOk) {
      buyStrength = 0.8;
      buyReason = `RSI bounce (${currentRsi.toFixed(1)})`;
      if (emaBullish) { buyStrength = 0.85; buyReason += ' + EMA bullish'; }
      if (belowAvg) { buyStrength = Math.min(1, buyStrength + 0.1); buyReason += ` + ${(priceDeviation * 100).toFixed(2)}% below avg`; }
    } else if (rsiBuyZone && belowAvg && spreadOk && (emaBullCross || emaBullish)) {
      buyStrength = 0.8;
      buyReason = `RSI ${currentRsi.toFixed(1)} + below avg ${(priceDeviation * 100).toFixed(2)}%`;
      if (emaBullCross) buyReason += ' + EMA cross';
    } else if (emaBullCross && rsiBuyZone && spreadOk) {
      buyStrength = 0.78;
      buyReason = `EMA cross + RSI ${currentRsi.toFixed(1)}`;
    }

    // Log indicator state — top pairs every tick, others less often
    const isTopPair = ['BTC-USD', 'ETH-USD', 'SOL-USD'].includes(snap.pair);
    if (isTopPair || history.length % 5 === 0) {
      const emaTrend = emaBullish ? 'bull' : 'bear';
      const devStr = `${priceDeviation >= 0 ? '+' : ''}${(priceDeviation * 100).toFixed(3)}%`;
      console.log(`[multi] ${snap.pair} RSI=${currentRsi.toFixed(0)} EMA=${emaTrend} dev=${devStr} str=${buyStrength.toFixed(2)}`);
    }

    if (buyStrength >= 0.75) {
      console.log(`[multi] ${snap.pair} ★ BUY: ${buyReason} (str=${buyStrength.toFixed(2)})`);
      return { side: 'buy', strength: buyStrength, reason: buyReason };
    }

    // ── SELL signals ──
    const rsiOverbought = prevRsi > 65 && currentRsi <= 65;
    const emaBearCross = fastPrev >= slowPrev && fastNow < slowNow;

    if (rsiOverbought || emaBearCross) {
      const reason = [rsiOverbought ? `RSI reversal (${currentRsi.toFixed(1)})` : '', emaBearCross ? 'EMA bear cross' : ''].filter(Boolean).join(' + ');
      console.log(`[multi] ${snap.pair} ★ SELL: ${reason}`);
      return { side: 'sell', strength: 0.8, reason };
    }

    return null;
  },
};

// ─── Scalp Strategy ────────────────────────────────────────────
//
// Quick trades: buy on short-term dips, sell on bounces.
// Uses 5-tick rate of change + RSI on a shorter period.

export const scalpStrategy: Strategy = {
  id: 'scalp',
  evaluate(snap: MarketSnapshot, history: MarketSnapshot[]): Signal | null {
    if (history.length < 10) return null;

    const bids = history.map((s) => s.bid);
    const recent5 = bids.slice(-5);
    const recent10 = bids.slice(-10);

    // Rate of change over last 5 ticks (25 seconds)
    const roc5 = (recent5[recent5.length - 1] - recent5[0]) / recent5[0] * 100;

    // Short-period RSI (7-period for faster signals)
    const shortRsi = rsi(bids, 7);

    // Volatility: std dev of last 10 ticks
    const mean10 = sma(recent10, 10);
    const variance = recent10.reduce((sum, v) => sum + (v - mean10) ** 2, 0) / recent10.length;
    const volatility = Math.sqrt(variance) / mean10 * 100; // as % of price

    // Spread check
    const spread = spreadPct(snap);

    // ── Scalp BUY: price dipped, RSI low, volatility present ──
    if (roc5 < -0.05 && shortRsi < 35 && volatility > 0.01 && spread < 0.05) {
      const reason = `scalp dip: roc5=${roc5.toFixed(3)}% RSI7=${shortRsi.toFixed(1)} vol=${volatility.toFixed(3)}%`;
      console.log(`[scalp] ${snap.pair} BUY: ${reason}`);
      return { side: 'buy', strength: 0.78, reason };
    }

    // ── Scalp BUY: sharp drop recovery (V-shaped bounce start) ──
    if (bids.length >= 6) {
      const low3 = Math.min(...bids.slice(-3));
      const low6 = Math.min(...bids.slice(-6, -3));
      const dropPct = (low3 - low6) / low6 * 100;
      const recovering = snap.bid > low3 && snap.bid > bids[bids.length - 2];
      if (dropPct < -0.08 && recovering && shortRsi < 40 && spread < 0.05) {
        const reason = `scalp V-bounce: drop=${dropPct.toFixed(3)}% recovering RSI7=${shortRsi.toFixed(1)}`;
        console.log(`[scalp] ${snap.pair} BUY: ${reason}`);
        return { side: 'buy', strength: 0.8, reason };
      }
    }

    // Log scalp indicators every tick for visibility
    if (history.length % 3 === 0) {
      console.log(`[scalp] ${snap.pair} roc5=${roc5.toFixed(3)}% RSI7=${shortRsi.toFixed(1)} vol=${volatility.toFixed(3)}% spread=${spread.toFixed(4)}%`);
    }

    // ── Scalp SELL: price bounced, RSI high ──
    if (roc5 > 0.05 && shortRsi > 65) {
      const reason = `scalp bounce: roc5=+${roc5.toFixed(3)}% RSI7=${shortRsi.toFixed(1)}`;
      console.log(`[scalp] ${snap.pair} SELL: ${reason}`);
      return { side: 'sell', strength: 0.8, reason };
    }

    return null;
  },
};

// ─── Composite Strategy ────────────────────────────────────────
//
// Runs both strategies. Takes whichever fires. Scalp gets slight
// priority since it's designed for quicker entries.

export const compositeStrategy: Strategy = {
  id: 'composite',
  evaluate(snap: MarketSnapshot, history: MarketSnapshot[]): Signal | null {
    // Try scalp first (faster signals)
    const scalp = scalpStrategy.evaluate(snap, history);
    if (scalp) return apply15mTrendFilter(scalp, snap, history);

    // Then multi-signal (swing)
    const multi = multiSignalStrategy.evaluate(snap, history);
    if (multi) return apply15mTrendFilter(multi, snap, history);

    return null;
  },
};
