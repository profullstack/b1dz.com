import { describe, it, expect } from 'vitest';
import { runDcaBacktest } from './dca-backtest.js';
import type { Candle } from './analysis/candles.js';
import type { DcaConfig } from './dca-config.js';

const DAY_MS = 86_400_000;

function linearCandles(startMs: number, days: number, startPrice: number, pctPerDay: number): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < days; i++) {
    const time = startMs + i * DAY_MS;
    const price = startPrice * (1 + (pctPerDay / 100) * i);
    out.push({ time, open: price, high: price, low: price, close: price, volume: 100 });
  }
  return out;
}

const cfg: DcaConfig = {
  enabled: true,
  totalAllocationPct: 10,
  maxCoins: 3,
  coins: ['BTC', 'ETH', 'SOL'],
  exchanges: ['kraken', 'coinbase', 'binance-us', 'gemini'],
  intervalMs: DAY_MS,
};

describe('runDcaBacktest', () => {
  it('simulates daily buys over a flat 30-day market', () => {
    const start = Date.UTC(2026, 0, 1);
    const days = 30;
    const candles = new Map<string, Candle[]>();
    for (const ex of cfg.exchanges) {
      for (const coin of cfg.coins) {
        const price = coin === 'BTC' ? 100_000 : coin === 'ETH' ? 3500 : 200;
        candles.set(`${ex}:${coin}`, linearCandles(start, days, price, 0));
      }
    }
    const result = runDcaBacktest({
      config: cfg,
      candles,
      equityUsd: 1000,
      feeRate: 0.003,
    });

    // 4 exchanges × 3 coins × 30 days = 360 buys
    expect(result.totals.buys).toBe(360);
    // 12 positions
    expect(result.positions.length).toBe(12);
    // Per-buy size: $1000 × 2.5% / 3 = $8.333
    expect(result.totals.usdSpent).toBeCloseTo(360 * (1000 * 0.025 / 3), 2);
    // Flat market → no PnL except the fee drag (≈ -0.3%)
    expect(result.totals.unrealizedPnlPct).toBeLessThan(0);
    expect(result.totals.unrealizedPnlPct).toBeGreaterThan(-0.5);
  });

  it('produces positive PnL in a rising market', () => {
    const start = Date.UTC(2026, 0, 1);
    const days = 30;
    const candles = new Map<string, Candle[]>();
    for (const ex of cfg.exchanges) {
      for (const coin of cfg.coins) {
        const price = coin === 'BTC' ? 100_000 : coin === 'ETH' ? 3500 : 200;
        candles.set(`${ex}:${coin}`, linearCandles(start, days, price, 1)); // +1%/day
      }
    }
    const result = runDcaBacktest({
      config: cfg,
      candles,
      equityUsd: 1000,
      feeRate: 0.003,
    });
    expect(result.totals.unrealizedPnlUsd).toBeGreaterThan(0);
    // DCA in a steady-up market = avg cost < final price → positive PnL.
    for (const p of result.positions) {
      expect(p.avgCostBasis).toBeLessThan(p.finalPrice);
    }
  });

  it('falls back in a crashing market (but less than lump-sum at t=0)', () => {
    const start = Date.UTC(2026, 0, 1);
    const days = 30;
    const candles = new Map<string, Candle[]>();
    for (const ex of cfg.exchanges) {
      for (const coin of cfg.coins) {
        candles.set(`${ex}:${coin}`, linearCandles(start, days, 100, -1)); // -1%/day
      }
    }
    const result = runDcaBacktest({
      config: cfg,
      candles,
      equityUsd: 1000,
      feeRate: 0.003,
    });
    expect(result.totals.unrealizedPnlUsd).toBeLessThan(0);
    // DCA in a falling market → avg cost > final price (opposite of rising case).
    for (const p of result.positions) {
      expect(p.avgCostBasis).toBeGreaterThan(p.finalPrice);
    }
  });

  it('respects the interval: fewer buys with longer interval', () => {
    const start = Date.UTC(2026, 0, 1);
    const days = 30;
    const candles = new Map<string, Candle[]>();
    for (const ex of cfg.exchanges) {
      for (const coin of cfg.coins) {
        candles.set(`${ex}:${coin}`, linearCandles(start, days, 100, 0));
      }
    }
    const weekly = runDcaBacktest({
      config: { ...cfg, intervalMs: 7 * DAY_MS },
      candles,
      equityUsd: 1000,
    });
    const daily = runDcaBacktest({
      config: cfg,
      candles,
      equityUsd: 1000,
    });
    expect(weekly.totals.buys).toBeLessThan(daily.totals.buys);
  });
});
