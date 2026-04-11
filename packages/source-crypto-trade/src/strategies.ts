/**
 * Trading strategies for single-exchange (Kraken) crypto trading.
 *
 * Each strategy implements the Strategy interface from index.ts.
 * The multi-signal strategy combines several indicators that must
 * agree before entering a trade — reduces false entries significantly.
 */

import type { MarketSnapshot } from '@b1dz/core';

// Re-declare interfaces here to avoid circular import with index.ts
interface Signal {
  side: 'buy' | 'sell';
  strength: number;
  reason: string;
}

interface Strategy {
  id: string;
  evaluate(snap: MarketSnapshot, history: MarketSnapshot[]): Signal | null;
}

// ─── Indicator helpers ─────────────────────────────────────────

/** Exponential Moving Average over `period` ticks. */
function ema(values: number[], period: number): number[] {
  if (values.length === 0) return [];
  const k = 2 / (period + 1);
  const result = [values[0]];
  for (let i = 1; i < values.length; i++) {
    result.push(values[i] * k + result[i - 1] * (1 - k));
  }
  return result;
}

/** Simple Moving Average over last `period` values. */
function sma(values: number[], period: number): number {
  if (values.length < period) return values.reduce((a, b) => a + b, 0) / values.length;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

/**
 * RSI (Relative Strength Index) — 14-period by default.
 * Returns 0-100. Below 30 = oversold, above 70 = overbought.
 */
function rsi(prices: number[], period = 14): number {
  if (prices.length < period + 1) return 50; // neutral when insufficient data

  let avgGain = 0;
  let avgLoss = 0;

  // Initial average over first `period` changes
  for (let i = 1; i <= period; i++) {
    const change = prices[i] - prices[i - 1];
    if (change > 0) avgGain += change;
    else avgLoss -= change;
  }
  avgGain /= period;
  avgLoss /= period;

  // Smoothed RSI for remaining prices
  for (let i = period + 1; i < prices.length; i++) {
    const change = prices[i] - prices[i - 1];
    avgGain = (avgGain * (period - 1) + (change > 0 ? change : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (change < 0 ? -change : 0)) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/** Bid-ask spread as a percentage of mid price. */
function spreadPct(snap: MarketSnapshot): number {
  const mid = (snap.bid + snap.ask) / 2;
  return ((snap.ask - snap.bid) / mid) * 100;
}

// ─── Multi-Signal Strategy ─────────────────────────────────────

/**
 * Combines RSI, EMA crossover, mean-reversion, and spread quality.
 * Only enters when multiple indicators confirm — high selectivity.
 */
export const multiSignalStrategy: Strategy = {
  id: 'multi-signal',
  evaluate(snap: MarketSnapshot, history: MarketSnapshot[]): Signal | null {
    // Need at least 30 ticks for indicators to stabilize
    if (history.length < 30) return null;

    const bids = history.map((s) => s.bid);
    const currentRsi = rsi(bids);
    const prevRsi = rsi(bids.slice(0, -1));

    const ema8 = ema(bids, 8);
    const ema21 = ema(bids, 21);
    const fastNow = ema8[ema8.length - 1];
    const slowNow = ema21[ema21.length - 1];
    const fastPrev = ema8[ema8.length - 2];
    const slowPrev = ema21[ema21.length - 2];

    const avg50 = sma(bids, 50);
    const priceDeviation = (snap.bid - avg50) / avg50;

    // Spread quality — only trade when spread is tight
    const currentSpread = spreadPct(snap);
    const avgSpread = sma(history.slice(-20).map((s) => spreadPct(s)), 20);
    const spreadOk = currentSpread <= avgSpread * 1.5;

    // ── BUY signals ──

    // RSI oversold bounce: was below 30, now crossing back above
    const rsiBounce = prevRsi < 30 && currentRsi >= 30;
    // RSI in buying zone (below 40 — not yet overbought)
    const rsiBuyZone = currentRsi < 40;

    // EMA bullish cross: fast crosses above slow
    const emaBullCross = fastPrev <= slowPrev && fastNow > slowNow;
    // EMA bullish: fast is above slow (trend confirmation)
    const emaBullish = fastNow > slowNow;

    // Mean reversion: price is significantly below average
    const belowAvg = priceDeviation < -0.003; // >0.3% below

    // ── Composite buy signal ──
    // Must have: (RSI bounce OR (RSI buy zone AND below average)) AND spread OK
    // Plus at least one trend confirmation
    let buyStrength = 0;
    let buyReason = '';

    if (rsiBounce && spreadOk) {
      buyStrength = 0.8;
      buyReason = `RSI bounce (${currentRsi.toFixed(1)})`;
      if (emaBullish) {
        buyStrength = 0.9;
        buyReason += ' + EMA bullish';
      }
      if (belowAvg) {
        buyStrength = Math.min(1, buyStrength + 0.1);
        buyReason += ` + ${(priceDeviation * 100).toFixed(2)}% below avg`;
      }
    } else if (rsiBuyZone && belowAvg && emaBullCross && spreadOk) {
      buyStrength = 0.85;
      buyReason = `EMA cross + RSI ${currentRsi.toFixed(1)} + ${(priceDeviation * 100).toFixed(2)}% below avg`;
    }

    if (buyStrength >= 0.75) {
      if (!spreadOk) {
        console.log(`[strategy] ${snap.pair} buy signal blocked by wide spread (${currentSpread.toFixed(4)}% vs avg ${avgSpread.toFixed(4)}%)`);
        return null;
      }
      console.log(`[strategy] ${snap.pair} BUY signal: ${buyReason} (strength=${buyStrength.toFixed(2)})`);
      return { side: 'buy', strength: buyStrength, reason: buyReason };
    }

    // ── SELL signals (for exit — evaluated separately from stop/take-profit) ──
    const rsiOverbought = prevRsi > 70 && currentRsi <= 70;
    const emaBearCross = fastPrev >= slowPrev && fastNow < slowNow;
    const aboveAvg = priceDeviation > 0.003;

    if (rsiOverbought && emaBearCross) {
      console.log(`[strategy] ${snap.pair} SELL signal: RSI overbought reversal + EMA bear cross`);
      return { side: 'sell', strength: 0.85, reason: `RSI reversal (${currentRsi.toFixed(1)}) + EMA bear cross` };
    }

    // Log indicator state periodically (every 10th tick)
    if (history.length % 10 === 0) {
      console.log(`[strategy] ${snap.pair} RSI=${currentRsi.toFixed(1)} EMA8/21=${fastNow.toFixed(2)}/${slowNow.toFixed(2)} dev=${(priceDeviation * 100).toFixed(3)}% spread=${currentSpread.toFixed(4)}%`);
    }

    return null;
  },
};

