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
const krakenSubscribedSymbols = new Set<string>();
const coinbaseSubscribedPairs = new Set<string>();
const binanceSubscribedSymbols = new Set<string>();
let binanceRequestId = 1;

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

function currentCanonicalPair(exchange: string, symbol: string): string | null {
  for (const pair of subscribedPairs) {
    const normalized = normalizePair(pair, exchange);
    if (symbol === normalized || symbol?.includes(normalized)) return pair;
  }
  return null;
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

function subscribeKrakenPairs(ws: WebSocket, pairs: string[]) {
  const nextSymbols = pairs
    .map((p) => normalizePair(p, 'kraken'))
    .filter((symbol) => !krakenSubscribedSymbols.has(symbol));
  if (nextSymbols.length === 0) return;
  for (const symbol of nextSymbols) krakenSubscribedSymbols.add(symbol);
  ws.send(JSON.stringify({
    method: 'subscribe',
    params: {
      channel: 'ticker',
      symbol: nextSymbols,
    },
  }));
}

function connectKraken(pairs: string[]) {
  if (krakenWs) return;
  const ws = new WebSocket('wss://ws.kraken.com/v2');
  krakenWs = ws;

  ws.on('open', () => {
    if (krakenWs !== ws) return;
    krakenSubscribedSymbols.clear();
    wsLog('[ws] kraken connected');
    subscribeKrakenPairs(ws, [...subscribedPairs]);
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
          const pair = currentCanonicalPair('kraken', tick.symbol);
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
      krakenSubscribedSymbols.clear();
      setTimeout(() => connectKraken([...subscribedPairs]), 5000);
    }
  });

  ws.on('error', (e) => {
    wsLog(`[ws] ✗ kraken error: ${e.message}`);
  });
}

// ─── Coinbase WebSocket ────────────────────────────────────────

let coinbaseWs: WebSocket | null = null;

function subscribeCoinbasePairs(ws: WebSocket, pairs: string[]) {
  const nextPairs = pairs.filter((pair) => !coinbaseSubscribedPairs.has(pair));
  if (nextPairs.length === 0) return;
  for (const pair of nextPairs) coinbaseSubscribedPairs.add(pair);
  ws.send(JSON.stringify({
    type: 'subscribe',
    product_ids: nextPairs,
    channel: 'ticker',
  }));
  ws.send(JSON.stringify({
    type: 'subscribe',
    product_ids: nextPairs,
    channel: 'heartbeats',
  }));
}

function connectCoinbase(pairs: string[]) {
  if (coinbaseWs) return;
  const ws = new WebSocket('wss://advanced-trade-ws.coinbase.com');
  coinbaseWs = ws;

  ws.on('open', () => {
    if (coinbaseWs !== ws) return;
    coinbaseSubscribedPairs.clear();
    wsLog('[ws] coinbase connected');
    subscribeCoinbasePairs(ws, [...subscribedPairs]);
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
      coinbaseSubscribedPairs.clear();
      setTimeout(() => connectCoinbase([...subscribedPairs]), 5000);
    }
  });

  ws.on('error', (e) => {
    wsLog(`[ws] ✗ coinbase error: ${e.message}`);
  });
}

// ─── Binance.US WebSocket ──────────────────────────────────────

let binanceWs: WebSocket | null = null;

function subscribeBinancePairs(ws: WebSocket, pairs: string[]) {
  const nextSymbols = pairs
    .map((p) => `${normalizePair(p, 'binance-us').toLowerCase()}@bookTicker`)
    .filter((symbol) => !binanceSubscribedSymbols.has(symbol));
  if (nextSymbols.length === 0) return;
  for (const symbol of nextSymbols) binanceSubscribedSymbols.add(symbol);
  ws.send(JSON.stringify({
    method: 'SUBSCRIBE',
    params: nextSymbols,
    id: binanceRequestId++,
  }));
}

function connectBinance(pairs: string[]) {
  if (binanceWs) return;
  const url = 'wss://stream.binance.us:9443/ws';
  const ws = new WebSocket(url);
  binanceWs = ws;

  ws.on('open', () => {
    if (binanceWs !== ws) return;
    binanceSubscribedSymbols.clear();
    wsLog('[ws] binance.us connected');
    subscribeBinancePairs(ws, [...subscribedPairs]);
    const pingTimer = setInterval(() => {
      if (binanceWs === ws && ws.readyState === WebSocket.OPEN) ws.ping();
      else clearInterval(pingTimer);
    }, 30000);
  });

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      const data = msg.data ?? msg;
      if (data?.s && data?.b && data?.a) {
        const pair = currentCanonicalPair('binance-us', data.s);
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
      binanceSubscribedSymbols.clear();
      setTimeout(() => connectBinance([...subscribedPairs]), 5000);
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
  if (!initialized) {
    wsLog(`[ws] subscribing to ${allPairs.length} pairs on kraken + coinbase + binance.us`);
    connectKraken(allPairs);
    connectCoinbase(allPairs);
    connectBinance(allPairs);
    initialized = true;
    return;
  }

  if (newPairs.length > 0) {
    wsLog(`[ws] subscribing to ${newPairs.length} new pair${newPairs.length === 1 ? '' : 's'} (${subscribedPairs.size} total)`);
  }
  if (krakenWs?.readyState === WebSocket.OPEN) subscribeKrakenPairs(krakenWs, newPairs);
  else connectKraken(allPairs);
  if (coinbaseWs?.readyState === WebSocket.OPEN) subscribeCoinbasePairs(coinbaseWs, newPairs);
  else connectCoinbase(allPairs);
  if (binanceWs?.readyState === WebSocket.OPEN) subscribeBinancePairs(binanceWs, newPairs);
  else connectBinance(allPairs);
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
