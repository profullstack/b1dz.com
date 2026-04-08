/**
 * Crypto day-trading source — single-exchange strategies (momentum,
 * mean-reversion, breakout). Reuses the PriceFeed implementations from
 * @b1dz/source-crypto-arb so we don't double up on websockets/REST.
 *
 *   poll()      → snapshot configured pairs from one exchange
 *   evaluate()  → run strategy; if signal fires, emit Opportunity
 *   act()       → place a market/limit order on the exchange
 *
 * Strategy is pluggable — pass a Strategy implementation when constructing
 * the source. Defaults to a simple momentum strategy stub below.
 */

import type { Source, MarketSnapshot, Opportunity, PriceFeed } from '@b1dz/core';
import { GeminiFeed } from '@b1dz/source-crypto-arb';

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

/** Placeholder momentum strategy — emits a buy if last 3 ticks are rising. */
export const momentumStrategy: Strategy = {
  id: 'momentum',
  evaluate(snap, history) {
    if (history.length < 3) return null;
    const recent = history.slice(-3);
    const rising = recent.every((s, i, a) => i === 0 || s.bid > a[i - 1].bid);
    if (!rising) return null;
    return { side: 'buy', strength: 0.6, reason: '3 rising ticks' };
  },
};

interface TradeItem {
  pair: string;
  snap: MarketSnapshot;
  history: MarketSnapshot[];
}

const PAIRS = ['BTC-USD', 'ETH-USD'];
const feed: PriceFeed = new GeminiFeed();
const histories = new Map<string, MarketSnapshot[]>();

export function makeCryptoTradeSource(strategy: Strategy = momentumStrategy): Source<TradeItem> {
  return {
    id: `crypto-trade:${feed.exchange}:${strategy.id}`,
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
      }
      return items;
    },
    evaluate(item): Opportunity | null {
      const sig = strategy.evaluate(item.snap, item.history);
      if (!sig) return null;
      const price = sig.side === 'buy' ? item.snap.ask : item.snap.bid;
      // No projected return without an exit strategy — leave at 0 and let
      // a separate "exit" pass mark the realized P/L.
      return {
        id: `crypto-trade:${feed.exchange}:${item.pair}:${Date.now()}`,
        sourceId: `crypto-trade:${feed.exchange}:${strategy.id}`,
        externalId: `${item.pair}:${Date.now()}`,
        title: `${sig.side.toUpperCase()} ${item.pair} @ ${price.toFixed(2)}`,
        category: 'crypto-trade',
        costNow: price,
        projectedReturn: 0,
        projectedProfit: 0,
        confidence: sig.strength,
        metadata: { strategy: strategy.id, signal: sig, snap: item.snap },
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
    },
    // act(): TODO — place order via authenticated client
  };
}

export const cryptoTradeSource: Source<TradeItem> = makeCryptoTradeSource();
