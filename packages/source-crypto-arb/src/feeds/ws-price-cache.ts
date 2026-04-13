/**
 * WebSocket-based price cache — maintains persistent connections to all exchanges.
 *
 * Usage:
 *   wsCache.subscribe(['BTC-USD', 'ETH-USD', 'SOL-USD']);
 *   const snap = wsCache.get('kraken', 'BTC-USD');
 *
 * Each exchange pushes real-time ticker updates into a shared Map.
 * The PriceFeed.snapshot() methods read from this cache instead of
 * making HTTP requests.
 */

import { WebSocket } from 'ws';
import type { MarketSnapshot } from '@b1dz/core';
import { normalizePair } from './pairs.js';

interface CacheEntry extends MarketSnapshot {
  stale: boolean;
}

const cache = new Map<string, CacheEntry>(); // key: "exchange:pair"
const subscribedPairs = new Set<string>();
let initialized = false;

let wsLogger: ((msg: string) => void) | null = null;
export function setWsLogger(fn: ((msg: string) => void) | null) { wsLogger = fn; }
function wsLog(msg: string) {
  if (wsLogger) {
    wsLogger(msg);
    return;
  }
  console.log(msg);
}

function cacheKey(exchange: string, pair: string): string {
  return `${exchange}:${pair}`;
}

export function getSnapshot(exchange: string, pair: string): MarketSnapshot | null {
  const entry = cache.get(cacheKey(exchange, pair));
  if (!entry || entry.stale) return null;
  // Consider stale after 10s without update
  if (Date.now() - entry.ts > 10_000) {
    entry.stale = true;
    return null;
  }
  return entry;
}

function setPrice(exchange: string, pair: string, bid: number, ask: number, bidSize = 0, askSize = 0) {
  cache.set(cacheKey(exchange, pair), {
    exchange, pair, bid, ask, bidSize, askSize,
    ts: Date.now(),
    stale: false,
  });
}

// ─── Kraken WebSocket ──────────────────────────────────────────

let krakenWs: WebSocket | null = null;

function connectKraken(pairs: string[]) {
  if (krakenWs) return;
  const krakenPairs = pairs.map((p) => normalizePair(p, 'kraken'));
  const ws = new WebSocket('wss://ws.kraken.com/v2');
  krakenWs = ws;

  ws.on('open', () => {
    if (krakenWs !== ws) return;
    wsLog('[ws] kraken connected');
    ws.send(JSON.stringify({
      method: 'subscribe',
      params: {
        channel: 'ticker',
        symbol: krakenPairs,
      },
    }));
    // Keepalive ping every 30s
    const pingTimer = setInterval(() => {
      if (krakenWs === ws && ws.readyState === WebSocket.OPEN) ws.ping();
      else clearInterval(pingTimer);
    }, 30000);
  });

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.channel === 'ticker' && msg.type === 'update' && msg.data) {
        for (const tick of msg.data) {
          // Find canonical pair from kraken symbol
          const pair = pairs.find((p) => {
            const norm = normalizePair(p, 'kraken');
            return tick.symbol === norm || tick.symbol?.includes(norm);
          });
          if (pair && tick.bid !== undefined && tick.ask !== undefined) {
            setPrice('kraken', pair,
              parseFloat(tick.bid), parseFloat(tick.ask),
              parseFloat(tick.bid_qty || '0'), parseFloat(tick.ask_qty || '0'),
            );
          }
        }
      }
    } catch {}
  });

  ws.on('close', () => {
    wsLog('[ws] ✗ kraken disconnected, reconnecting in 5s...');
    if (krakenWs === ws) {
      krakenWs = null;
      setTimeout(() => connectKraken(pairs), 5000);
    }
  });

  ws.on('error', (e) => {
    wsLog(`[ws] ✗ kraken error: ${e.message}`);
  });
}

// ─── Coinbase WebSocket ────────────────────────────────────────

let coinbaseWs: WebSocket | null = null;

function connectCoinbase(pairs: string[]) {
  if (coinbaseWs) return;
  const ws = new WebSocket('wss://advanced-trade-ws.coinbase.com');
  coinbaseWs = ws;

  ws.on('open', () => {
    if (coinbaseWs !== ws) return;
    wsLog('[ws] coinbase connected');
    ws.send(JSON.stringify({
      type: 'subscribe',
      product_ids: pairs,
      channel: 'ticker',
    }));
    ws.send(JSON.stringify({
      type: 'subscribe',
      product_ids: pairs,
      channel: 'heartbeats',
    }));
    const pingTimer = setInterval(() => {
      if (coinbaseWs === ws && ws.readyState === WebSocket.OPEN) ws.ping();
      else clearInterval(pingTimer);
    }, 30000);
  });

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.channel === 'ticker' && msg.events) {
        for (const event of msg.events) {
          if (event.type === 'update' && event.tickers) {
            for (const tick of event.tickers) {
              const pair = tick.product_id;
              if (pair && tick.best_bid !== undefined && tick.best_ask !== undefined) {
                setPrice('coinbase', pair,
                  parseFloat(tick.best_bid), parseFloat(tick.best_ask),
                  parseFloat(tick.best_bid_quantity || '0'), parseFloat(tick.best_ask_quantity || '0'),
                );
              }
            }
          }
        }
      }
    } catch {}
  });

  ws.on('close', (code, reason) => {
    const why = reason?.toString()?.trim();
    wsLog(`[ws] ✗ coinbase disconnected (${code}${why ? ` ${why}` : ''}), reconnecting in 5s...`);
    if (coinbaseWs === ws) {
      coinbaseWs = null;
      setTimeout(() => connectCoinbase(pairs), 5000);
    }
  });

  ws.on('error', (e) => {
    wsLog(`[ws] ✗ coinbase error: ${e.message}`);
  });
}

// ─── Binance.US WebSocket ──────────────────────────────────────

let binanceWs: WebSocket | null = null;

function connectBinance(pairs: string[]) {
  if (binanceWs) return;
  const streams = pairs.map((p) => `${normalizePair(p, 'binance-us').toLowerCase()}@bookTicker`);
  const url = `wss://stream.binance.us:9443/stream?streams=${streams.join('/')}`;
  const ws = new WebSocket(url);
  binanceWs = ws;

  ws.on('open', () => {
    if (binanceWs !== ws) return;
    wsLog('[ws] binance.us connected');
    const pingTimer = setInterval(() => {
      if (binanceWs === ws && ws.readyState === WebSocket.OPEN) ws.ping();
      else clearInterval(pingTimer);
    }, 30000);
  });

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      const data = msg.data;
      if (data?.s && data?.b && data?.a) {
        // Find canonical pair from binance symbol
        const pair = pairs.find((p) => normalizePair(p, 'binance-us') === data.s);
        if (pair) {
          setPrice('binance-us', pair,
            parseFloat(data.b), parseFloat(data.a),
            parseFloat(data.B || '0'), parseFloat(data.A || '0'),
          );
        }
      }
    } catch {}
  });

  ws.on('close', () => {
    wsLog('[ws] ✗ binance.us disconnected, reconnecting in 5s...');
    if (binanceWs === ws) {
      binanceWs = null;
      setTimeout(() => connectBinance(pairs), 5000);
    }
  });

  ws.on('error', (e) => {
    wsLog(`[ws] ✗ binance.us error: ${e.message}`);
  });
}

// ─── Public API ────────────────────────────────────────────────

/**
 * Subscribe to price updates for the given pairs.
 * Safe to call multiple times — new pairs are added, existing ones kept.
 */
export function subscribe(pairs: string[]) {
  const newPairs = pairs.filter((p) => !subscribedPairs.has(p));
  if (newPairs.length === 0 && initialized) return;

  for (const p of newPairs) subscribedPairs.add(p);
  const allPairs = [...subscribedPairs];

  // Reconnect with updated pair list
  if (krakenWs) { krakenWs.close(); krakenWs = null; }
  if (coinbaseWs) { coinbaseWs.close(); coinbaseWs = null; }
  if (binanceWs) { binanceWs.close(); binanceWs = null; }

  // Binance.US blocks datacenter IPs — WS won't work, use REST polling via proxy instead
  wsLog(`[ws] subscribing to ${allPairs.length} pairs on kraken + coinbase (binance uses REST/proxy)`);
  connectKraken(allPairs);
  connectCoinbase(allPairs);
  initialized = true;
}

/** Get all cached snapshots for a pair across all exchanges. */
export function getAllSnapshots(pair: string): MarketSnapshot[] {
  const result: MarketSnapshot[] = [];
  for (const exchange of ['kraken', 'coinbase', 'binance-us']) {
    const snap = getSnapshot(exchange, pair);
    if (snap) result.push(snap);
  }
  return result;
}

/** How many prices are in the cache. */
export function cacheSize(): number {
  return cache.size;
}
