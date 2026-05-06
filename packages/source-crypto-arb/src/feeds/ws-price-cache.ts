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
 *
 * Reliability features:
 *   1. Watchdog — every WATCHDOG_INTERVAL_MS we check `lastMessageAt` for
 *      every connection. If a connection has gone silent for longer than
 *      STALL_THRESHOLD_MS, we force-close it. The on('close') handler
 *      then reconnects via the same path as a real disconnect. This is
 *      the single most important reliability fix — TCP connections silently
 *      stall behind NATs and load balancers all the time, leaving the
 *      socket "open" but with no traffic flowing.
 *   2. Exponential backoff with jitter — fixed-interval reconnects
 *      hammer broken endpoints; we back off 1s → 60s with full jitter.
 *      Successful 'open' resets the backoff.
 *   3. Per-connection lastMessageAt — every inbound frame (including
 *      heartbeats) updates this so the watchdog only triggers on real
 *      silence, not "no ticker movement".
 */

import { WebSocket } from 'ws';
import type { MarketSnapshot } from '@b1dz/core';
import { normalizePair } from './pairs.js';

interface CacheEntry extends MarketSnapshot {
  stale: boolean;
}

const cache = new Map<string, CacheEntry>(); // key: "exchange:pair"
const subscribedPairs = new Set<string>();
const subscriptionRefs = new Map<string, number>();
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

// ─── Reliability primitives: watchdog + exponential backoff ────

/** Connections silent longer than this are considered stalled and
 *  force-closed. CEX ticker streams emit something at least every few
 *  seconds for liquid pairs (heartbeats + ticks). 45s of total silence
 *  across all subscriptions is unambiguous: the TCP socket has been
 *  evicted by an intermediate NAT/LB but the local kernel hasn't
 *  noticed. Force-closing triggers our existing reconnect path. */
const STALL_THRESHOLD_MS = 45_000;
/** How often the watchdog ticks. Trades off detection latency for CPU. */
const WATCHDOG_INTERVAL_MS = 10_000;

const BACKOFF_INITIAL_MS = 1_000;
const BACKOFF_MAX_MS = 60_000;

interface ConnectionHealth {
  /** Last inbound message wallclock — set by every on('message') handler
   *  AND set fresh on every 'open' event. 0 means "never received". */
  lastMessageAt: number;
  /** Current reconnect delay floor. Doubled on each consecutive failure
   *  (reset to BACKOFF_INITIAL_MS on a successful 'open'). Pre-jitter. */
  backoffMs: number;
  /** True while we're inside the reconnect setTimeout window. Prevents
   *  the watchdog from queueing a second reconnect on top of one already
   *  in flight. */
  reconnectScheduled: boolean;
}

function newHealth(): ConnectionHealth {
  return { lastMessageAt: 0, backoffMs: BACKOFF_INITIAL_MS, reconnectScheduled: false };
}

const krakenHealth = newHealth();
const coinbaseHealth = newHealth();
const binanceHealth = newHealth();
/** Per-symbol health for Gemini — Gemini uses one socket per pair, so
 *  there is no shared connection-level health. */
const geminiHealth = new Map<string, ConnectionHealth>();

function noteMessage(h: ConnectionHealth) {
  h.lastMessageAt = Date.now();
}

function noteOpen(h: ConnectionHealth) {
  h.lastMessageAt = Date.now();
  h.backoffMs = BACKOFF_INITIAL_MS;
}

/** Compute the next reconnect delay with full jitter (AWS-style):
 *  random uniform in [0, backoffMs], then double the floor for next
 *  failure, capped at BACKOFF_MAX_MS. Returns the delay to use NOW. */
function nextReconnectDelay(h: ConnectionHealth): number {
  const cap = h.backoffMs;
  const delay = Math.floor(Math.random() * cap);
  // Pre-compute next failure's ceiling so consecutive failures grow.
  h.backoffMs = Math.min(h.backoffMs * 2, BACKOFF_MAX_MS);
  return Math.max(250, delay); // never zero — let the event loop breathe
}

function scheduleReconnect(h: ConnectionHealth, fn: () => void): void {
  if (h.reconnectScheduled) return;
  h.reconnectScheduled = true;
  const delay = nextReconnectDelay(h);
  setTimeout(() => {
    h.reconnectScheduled = false;
    fn();
  }, delay);
}

let watchdogTimer: ReturnType<typeof setInterval> | null = null;

function startWatchdog() {
  if (watchdogTimer) return;
  watchdogTimer = setInterval(() => {
    const now = Date.now();
    if (krakenWs && krakenHealth.lastMessageAt > 0 && now - krakenHealth.lastMessageAt > STALL_THRESHOLD_MS) {
      wsLog(`[ws] ⚠ kraken stalled ${Math.floor((now - krakenHealth.lastMessageAt) / 1000)}s — force-closing`);
      try { krakenWs.close(); } catch { /* socket already torn down */ }
    }
    if (coinbaseWs && coinbaseHealth.lastMessageAt > 0 && now - coinbaseHealth.lastMessageAt > STALL_THRESHOLD_MS) {
      wsLog(`[ws] ⚠ coinbase stalled ${Math.floor((now - coinbaseHealth.lastMessageAt) / 1000)}s — force-closing`);
      try { coinbaseWs.close(); } catch { /* socket already torn down */ }
    }
    if (binanceWs && binanceHealth.lastMessageAt > 0 && now - binanceHealth.lastMessageAt > STALL_THRESHOLD_MS) {
      wsLog(`[ws] ⚠ binance.us stalled ${Math.floor((now - binanceHealth.lastMessageAt) / 1000)}s — force-closing`);
      try { binanceWs.close(); } catch { /* socket already torn down */ }
    }
    for (const [symbol, ws] of geminiSockets) {
      const h = geminiHealth.get(symbol);
      if (!h || h.lastMessageAt === 0) continue;
      if (now - h.lastMessageAt > STALL_THRESHOLD_MS) {
        wsLog(`[ws] ⚠ gemini ${symbol} stalled ${Math.floor((now - h.lastMessageAt) / 1000)}s — force-closing`);
        try { ws.close(); } catch { /* socket already torn down */ }
      }
    }
  }, WATCHDOG_INTERVAL_MS).unref?.() as unknown as ReturnType<typeof setInterval> ?? null;
  // Note: .unref() lets the process exit naturally if all other timers are gone.
}

function stopWatchdog() {
  if (watchdogTimer) {
    clearInterval(watchdogTimer);
    watchdogTimer = null;
  }
}

function cacheKey(exchange: string, pair: string): string {
  return `${exchange}:${pair}`;
}

function websocketSymbol(exchange: string, pair: string): string {
  if (exchange === 'kraken') {
    const [base, quote] = pair.split('-');
    return `${base.toUpperCase()}/${quote.toUpperCase()}`;
  }
  return normalizePair(pair, exchange);
}

function currentCanonicalPair(exchange: string, symbol: string): string | null {
  for (const pair of subscribedPairs) {
    const normalized = websocketSymbol(exchange, pair);
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

function prunePairCache(pair: string) {
  for (const exchange of ['kraken', 'coinbase', 'binance-us', 'gemini']) {
    cache.delete(cacheKey(exchange, pair));
  }
  // Close the per-pair Gemini socket too, so release truly releases.
  const symbol = websocketSymbol('gemini', pair).toLowerCase();
  const ws = geminiSockets.get(symbol);
  if (ws) {
    geminiSockets.delete(symbol);
    geminiBooks.delete(symbol);
    geminiHealth.delete(symbol);
    try { ws.close(); } catch {}
  }
}

// ─── Kraken WebSocket ──────────────────────────────────────────

let krakenWs: WebSocket | null = null;

function subscribeKrakenPairs(ws: WebSocket, pairs: string[]) {
  const nextSymbols = pairs
    .map((p) => websocketSymbol('kraken', p))
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

function unsubscribeKrakenPairs(ws: WebSocket, pairs: string[]) {
  const symbols = pairs.map((p) => websocketSymbol('kraken', p));
  const activeSymbols = symbols.filter((symbol) => krakenSubscribedSymbols.has(symbol));
  if (activeSymbols.length === 0) return;
  for (const symbol of activeSymbols) krakenSubscribedSymbols.delete(symbol);
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({
    method: 'unsubscribe',
    params: {
      channel: 'ticker',
      symbol: activeSymbols,
    },
  }));
}

function connectKraken(_pairs: string[]) {
  if (krakenWs) return;
  const ws = new WebSocket('wss://ws.kraken.com/v2');
  krakenWs = ws;

  ws.on('open', () => {
    if (krakenWs !== ws) return;
    krakenSubscribedSymbols.clear();
    noteOpen(krakenHealth);
    wsLog('[ws] kraken connected');
    subscribeKrakenPairs(ws, [...subscribedPairs]);
    // Keepalive ping every 30s
    const pingTimer = setInterval(() => {
      if (krakenWs === ws && ws.readyState === WebSocket.OPEN) {
        try { ws.ping(); } catch { /* ping on closing socket — next tick will clear */ }
      } else clearInterval(pingTimer);
    }, 30000);
  });

  ws.on('message', (raw) => {
    noteMessage(krakenHealth);
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.method === 'subscribe' && msg.success === false) {
        wsLog(`[ws] ✗ kraken subscribe failed: ${msg.error ?? 'unknown error'}`);
        return;
      }
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

  // Ping/pong frames count as activity — without this, a market in a
  // dead spell looks "stalled" to the watchdog even though the socket
  // is healthy.
  ws.on('ping', () => noteMessage(krakenHealth));
  ws.on('pong', () => noteMessage(krakenHealth));

  ws.on('close', () => {
    if (krakenWs !== ws) return;
    krakenWs = null;
    krakenSubscribedSymbols.clear();
    if (subscribedPairs.size === 0) return;
    scheduleReconnect(krakenHealth, () => {
      wsLog(`[ws] kraken reconnecting (backoff ceiling=${krakenHealth.backoffMs}ms)`);
      connectKraken([...subscribedPairs]);
    });
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

function unsubscribeCoinbasePairs(ws: WebSocket, pairs: string[]) {
  const activePairs = pairs.filter((pair) => coinbaseSubscribedPairs.has(pair));
  if (activePairs.length === 0) return;
  for (const pair of activePairs) coinbaseSubscribedPairs.delete(pair);
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({
    type: 'unsubscribe',
    product_ids: activePairs,
    channel: 'ticker',
  }));
  ws.send(JSON.stringify({
    type: 'unsubscribe',
    product_ids: activePairs,
    channel: 'heartbeats',
  }));
}

function connectCoinbase(_pairs: string[]) {
  if (coinbaseWs) return;
  const ws = new WebSocket('wss://advanced-trade-ws.coinbase.com');
  coinbaseWs = ws;

  ws.on('open', () => {
    if (coinbaseWs !== ws) return;
    coinbaseSubscribedPairs.clear();
    noteOpen(coinbaseHealth);
    wsLog('[ws] coinbase connected');
    subscribeCoinbasePairs(ws, [...subscribedPairs]);
    const pingTimer = setInterval(() => {
      if (coinbaseWs === ws && ws.readyState === WebSocket.OPEN) {
        try { ws.ping(); } catch { /* ping on closing socket — next tick will clear */ }
      } else clearInterval(pingTimer);
    }, 30000);
  });

  ws.on('message', (raw) => {
    noteMessage(coinbaseHealth);
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'error') {
        wsLog(`[ws] ✗ coinbase error: ${msg.message ?? msg.reason ?? 'unknown error'}`);
        return;
      }
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

  ws.on('ping', () => noteMessage(coinbaseHealth));
  ws.on('pong', () => noteMessage(coinbaseHealth));

  ws.on('close', (code, reason) => {
    if (coinbaseWs !== ws) return;
    const why = reason?.toString()?.trim();
    coinbaseWs = null;
    coinbaseSubscribedPairs.clear();
    if (subscribedPairs.size === 0) {
      wsLog(`[ws] coinbase disconnected (${code}${why ? ` ${why}` : ''}) — no active pairs, not reconnecting`);
      return;
    }
    wsLog(`[ws] ✗ coinbase disconnected (${code}${why ? ` ${why}` : ''})`);
    scheduleReconnect(coinbaseHealth, () => {
      wsLog(`[ws] coinbase reconnecting (backoff ceiling=${coinbaseHealth.backoffMs}ms)`);
      connectCoinbase([...subscribedPairs]);
    });
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

function unsubscribeBinancePairs(ws: WebSocket, pairs: string[]) {
  const activeSymbols = pairs
    .map((p) => `${normalizePair(p, 'binance-us').toLowerCase()}@bookTicker`)
    .filter((symbol) => binanceSubscribedSymbols.has(symbol));
  if (activeSymbols.length === 0) return;
  for (const symbol of activeSymbols) binanceSubscribedSymbols.delete(symbol);
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({
    method: 'UNSUBSCRIBE',
    params: activeSymbols,
    id: binanceRequestId++,
  }));
}

function connectBinance(_pairs: string[]) {
  if (binanceWs) return;
  const url = 'wss://stream.binance.us:9443/ws';
  const ws = new WebSocket(url);
  binanceWs = ws;

  ws.on('open', () => {
    if (binanceWs !== ws) return;
    binanceSubscribedSymbols.clear();
    noteOpen(binanceHealth);
    wsLog('[ws] binance.us connected');
    subscribeBinancePairs(ws, [...subscribedPairs]);
    const pingTimer = setInterval(() => {
      if (binanceWs === ws && ws.readyState === WebSocket.OPEN) {
        try { ws.ping(); } catch { /* ping on closing socket — next tick will clear */ }
      } else clearInterval(pingTimer);
    }, 30000);
  });

  ws.on('message', (raw) => {
    noteMessage(binanceHealth);
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.id && msg.result === null && msg.error) {
        wsLog(`[ws] ✗ binance.us subscribe failed: ${msg.error.msg ?? msg.error.message ?? 'unknown error'}`);
        return;
      }
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

  ws.on('ping', () => noteMessage(binanceHealth));
  ws.on('pong', () => noteMessage(binanceHealth));

  ws.on('close', () => {
    if (binanceWs !== ws) return;
    binanceWs = null;
    binanceSubscribedSymbols.clear();
    if (subscribedPairs.size === 0) return;
    wsLog('[ws] ✗ binance.us disconnected');
    scheduleReconnect(binanceHealth, () => {
      wsLog(`[ws] binance.us reconnecting (backoff ceiling=${binanceHealth.backoffMs}ms)`);
      connectBinance([...subscribedPairs]);
    });
  });

  ws.on('error', (e) => {
    wsLog(`[ws] ✗ binance.us error: ${e.message}`);
  });
}

// ─── Gemini WebSocket ──────────────────────────────────────────
// Gemini uses per-symbol URLs: wss://api.gemini.com/v1/marketdata/{symbol}
// No subscribe message — connecting to the path IS the subscription. So
// we track one socket per pair rather than one global socket like the
// other venues. Gemini publishes L2 book events (events[].type='change')
// which we replay into a per-pair Map<priceString, remaining> for both
// sides of the book. After applying every event in a frame we recompute
// top bid (max key) and top ask (min key) and publish that. This is the
// only correct way to track top-of-book from L2 deltas — the previous
// "highest price ever seen" heuristic stuck on stale prices the moment
// the original top moved away.

const geminiSockets = new Map<string, WebSocket>();
interface GeminiBook {
  bids: Map<string, number>; // priceString → remaining
  asks: Map<string, number>;
}
const geminiBooks = new Map<string, GeminiBook>();
/** Pairs that returned a 400 on the ws handshake — meaning Gemini doesn't
 *  list that symbol. Stop retrying them to avoid the reconnect-storm that
 *  spammed hundreds of log lines per minute. Also used as a cache of the
 *  negative result from the /v1/symbols pre-check. */
const geminiDeadSymbols = new Set<string>();
/** Cache of symbols Gemini actually lists. Fetched once lazily and
 *  refreshed every hour — new listings are rare. */
let geminiListedSymbols: Set<string> | null = null;
let geminiSymbolsFetchedAt = 0;
let geminiSymbolsFetchInFlight: Promise<void> | null = null;
const GEMINI_SYMBOLS_TTL_MS = 60 * 60_000;

async function refreshGeminiSymbols(): Promise<void> {
  if (geminiSymbolsFetchInFlight) return geminiSymbolsFetchInFlight;
  if (geminiListedSymbols && Date.now() - geminiSymbolsFetchedAt < GEMINI_SYMBOLS_TTL_MS) return;
  geminiSymbolsFetchInFlight = (async () => {
    try {
      const res = await fetch('https://api.gemini.com/v1/symbols', { signal: AbortSignal.timeout(5000) });
      if (!res.ok) throw new Error(`gemini /v1/symbols ${res.status}`);
      const body = (await res.json()) as string[];
      const next = new Set<string>(body.map((s) => s.toLowerCase()));
      geminiListedSymbols = next;
      geminiSymbolsFetchedAt = Date.now();
      wsLog(`[ws] gemini symbol cache loaded (${next.size} listings)`);
    } catch (e) {
      // If the fetch fails we just fall through to the old behavior
      // (open WS and rely on the close-without-open path to blacklist).
      wsLog(`[ws] gemini symbols fetch failed: ${(e as Error).message.slice(0, 120)}`);
    } finally {
      geminiSymbolsFetchInFlight = null;
    }
  })();
  return geminiSymbolsFetchInFlight;
}

interface GeminiChangeEvent {
  type: 'change';
  side: 'bid' | 'ask';
  price: string;
  remaining: string;
  reason?: string;
}

/** Recompute top of a price-keyed level book. Returns null if no levels.
 *  Bids: highest price wins. Asks: lowest price wins. Numeric-aware
 *  comparison via parseFloat (price strings like "62354.10" must order
 *  correctly even when string lengths differ). */
function topOfBook(side: Map<string, number>, dir: 'bid' | 'ask'): number | null {
  let best: number | null = null;
  for (const priceStr of side.keys()) {
    const price = parseFloat(priceStr);
    if (!Number.isFinite(price) || price <= 0) continue;
    if (best === null) { best = price; continue; }
    if (dir === 'bid' ? price > best : price < best) best = price;
  }
  return best;
}

function connectGeminiPair(pair: string): void {
  const symbol = websocketSymbol('gemini', pair).toLowerCase();
  if (geminiSockets.has(symbol)) return;
  if (geminiDeadSymbols.has(symbol)) return; // Gemini doesn't list this pair
  // Pre-flight check against the /v1/symbols cache. If we know the list
  // and the symbol isn't in it, skip the connection entirely.
  if (geminiListedSymbols && !geminiListedSymbols.has(symbol)) {
    geminiDeadSymbols.add(symbol);
    return;
  }
  const ws = new WebSocket(`wss://api.gemini.com/v1/marketdata/${symbol}`);
  geminiSockets.set(symbol, ws);
  geminiBooks.set(symbol, { bids: new Map(), asks: new Map() });
  if (!geminiHealth.has(symbol)) geminiHealth.set(symbol, newHealth());
  const health = geminiHealth.get(symbol)!;
  let opened = false;

  ws.on('open', () => {
    if (geminiSockets.get(symbol) !== ws) return;
    opened = true;
    noteOpen(health);
    wsLog(`[ws] gemini connected ${symbol}`);
  });

  ws.on('message', (raw) => {
    noteMessage(health);
    try {
      const msg = JSON.parse(raw.toString()) as { events?: GeminiChangeEvent[] };
      if (!Array.isArray(msg.events)) return;
      const book = geminiBooks.get(symbol);
      if (!book) return;
      let touched = false;
      for (const ev of msg.events) {
        if (ev.type !== 'change') continue;
        const remaining = parseFloat(ev.remaining);
        const priceNum = parseFloat(ev.price);
        if (!Number.isFinite(remaining) || !Number.isFinite(priceNum) || priceNum <= 0) continue;
        const side = ev.side === 'bid' ? book.bids : ev.side === 'ask' ? book.asks : null;
        if (!side) continue;
        if (remaining > 0) side.set(ev.price, remaining);
        else side.delete(ev.price);
        touched = true;
      }
      if (touched) {
        const bid = topOfBook(book.bids, 'bid');
        const ask = topOfBook(book.asks, 'ask');
        if (bid !== null && ask !== null && bid > 0 && ask > 0) {
          setPrice('gemini', pair, bid, ask);
        }
      }
    } catch {}
  });

  ws.on('ping', () => noteMessage(health));
  ws.on('pong', () => noteMessage(health));

  ws.on('close', () => {
    if (geminiSockets.get(symbol) !== ws) return;
    geminiSockets.delete(symbol);
    geminiBooks.delete(symbol);
    // If the socket never successfully opened, Gemini doesn't list this
    // symbol. Mark dead to prevent a reconnect storm.
    if (!opened) {
      geminiDeadSymbols.add(symbol);
      geminiHealth.delete(symbol);
      wsLog(`[ws] gemini ${symbol} not listed — won't retry`);
      return;
    }
    wsLog(`[ws] ✗ gemini disconnected ${symbol}`);
    if (subscribedPairs.has(pair)) {
      scheduleReconnect(health, () => {
        wsLog(`[ws] gemini reconnecting ${symbol} (backoff ceiling=${health.backoffMs}ms)`);
        connectGeminiPair(pair);
      });
    } else {
      geminiHealth.delete(symbol);
    }
  });

  ws.on('error', (e) => {
    // 400 "Unexpected server response" = symbol not listed. Handled by
    // the close handler's `opened` check; suppress the noisy error log.
    const msg = e?.message ?? '';
    if (msg.includes('400')) return;
    wsLog(`[ws] ✗ gemini error ${symbol}: ${msg}`);
  });
}

function connectGemini(pairs: string[]): void {
  // Kick off the symbols fetch (no await — connections still work via
  // the close-handler blacklist path before the cache lands).
  void refreshGeminiSymbols().then(() => {
    // After the list arrives, retry any pairs that got blacklisted
    // from a prior "no opened before close" if they're actually listed.
    for (const p of pairs) {
      const sym = websocketSymbol('gemini', p).toLowerCase();
      if (geminiDeadSymbols.has(sym) && geminiListedSymbols?.has(sym)) {
        geminiDeadSymbols.delete(sym);
        connectGeminiPair(p);
      }
    }
  });
  for (const p of pairs) connectGeminiPair(p);
}

// ─── Public API ────────────────────────────────────────────────

/**
 * Subscribe to price updates for the given pairs.
 * Safe to call multiple times — new pairs are added, existing ones kept.
 */
export function subscribe(pairs: string[]) {
  retain(pairs);
}

function applyRetainCounts(pairs: string[]): string[] {
  const newPairs: string[] = [];
  for (const pair of pairs) {
    const nextRefCount = (subscriptionRefs.get(pair) ?? 0) + 1;
    subscriptionRefs.set(pair, nextRefCount);
    if (nextRefCount === 1) {
      subscribedPairs.add(pair);
      newPairs.push(pair);
    }
  }
  return newPairs;
}

function applyReleaseCounts(pairs: string[]): string[] {
  const releasedPairs: string[] = [];
  for (const pair of pairs) {
    const current = subscriptionRefs.get(pair) ?? 0;
    if (current <= 1) {
      subscriptionRefs.delete(pair);
      if (subscribedPairs.delete(pair)) {
        releasedPairs.push(pair);
      }
    } else {
      subscriptionRefs.set(pair, current - 1);
    }
  }
  return releasedPairs;
}

export function retain(pairs: string[]): () => void {
  const newPairs = applyRetainCounts(pairs);

  if (newPairs.length === 0 && initialized) {
    return () => release(pairs);
  }

  const allPairs = [...subscribedPairs];
  if (!initialized) {
    wsLog(`[ws] subscribing to ${allPairs.length} pairs on kraken + coinbase + binance.us + gemini`);
    connectKraken(allPairs);
    connectCoinbase(allPairs);
    connectBinance(allPairs);
    connectGemini(allPairs);
    startWatchdog();
    initialized = true;
    return () => release(pairs);
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
  // Gemini is per-pair connection; just open the new ones.
  connectGemini(newPairs);
  initialized = true;
  return () => release(pairs);
}

export function release(pairs: string[]) {
  const releasedPairs = applyReleaseCounts(pairs);
  if (releasedPairs.length === 0) return;

  for (const pair of releasedPairs) prunePairCache(pair);
  if (krakenWs) unsubscribeKrakenPairs(krakenWs, releasedPairs);
  if (coinbaseWs) unsubscribeCoinbasePairs(coinbaseWs, releasedPairs);
  if (binanceWs) unsubscribeBinancePairs(binanceWs, releasedPairs);
}

export function __resetWsCacheForTests() {
  cache.clear();
  subscribedPairs.clear();
  subscriptionRefs.clear();
  krakenSubscribedSymbols.clear();
  coinbaseSubscribedPairs.clear();
  binanceSubscribedSymbols.clear();
  geminiBooks.clear();
  geminiHealth.clear();
  initialized = false;
  stopWatchdog();
  // Reset health back to defaults so consecutive test cases start
  // from a clean exponential-backoff state.
  Object.assign(krakenHealth, newHealth());
  Object.assign(coinbaseHealth, newHealth());
  Object.assign(binanceHealth, newHealth());
}

export function __getWsCacheStateForTests() {
  return {
    cacheSize: cache.size,
    subscribedPairs: [...subscribedPairs].sort(),
    subscriptionRefs: [...subscriptionRefs.entries()].sort(([a], [b]) => a.localeCompare(b)),
  };
}

export function __retainWsPairsForTests(pairs: string[]) {
  return applyRetainCounts(pairs);
}

export function __releaseWsPairsForTests(pairs: string[]) {
  const released = applyReleaseCounts(pairs);
  for (const pair of released) prunePairCache(pair);
  return released;
}

/** Test hook: feed a fake L2 frame into the Gemini path so unit tests
 *  can verify book reconstruction without opening a real socket. */
export function __injectGeminiFrameForTests(pair: string, events: GeminiChangeEvent[]): MarketSnapshot | null {
  const symbol = websocketSymbol('gemini', pair).toLowerCase();
  if (!geminiBooks.has(symbol)) geminiBooks.set(symbol, { bids: new Map(), asks: new Map() });
  const book = geminiBooks.get(symbol)!;
  for (const ev of events) {
    if (ev.type !== 'change') continue;
    const remaining = parseFloat(ev.remaining);
    const priceNum = parseFloat(ev.price);
    if (!Number.isFinite(remaining) || !Number.isFinite(priceNum) || priceNum <= 0) continue;
    const side = ev.side === 'bid' ? book.bids : ev.side === 'ask' ? book.asks : null;
    if (!side) continue;
    if (remaining > 0) side.set(ev.price, remaining);
    else side.delete(ev.price);
  }
  const bid = topOfBook(book.bids, 'bid');
  const ask = topOfBook(book.asks, 'ask');
  if (bid !== null && ask !== null && bid > 0 && ask > 0) {
    setPrice('gemini', pair, bid, ask);
  }
  return cache.get(cacheKey('gemini', pair)) ?? null;
}

/** Get all cached snapshots for a pair across all exchanges. */
export function getAllSnapshots(pair: string): MarketSnapshot[] {
  const result: MarketSnapshot[] = [];
  for (const exchange of ['kraken', 'coinbase', 'binance-us', 'gemini']) {
    const snap = getSnapshot(exchange, pair);
    if (snap) result.push(snap);
  }
  return result;
}

/** How many prices are in the cache. */
export function cacheSize(): number {
  return cache.size;
}

/** Health snapshot for diagnostics — surfaced via daemon logs / web /api
 *  to make silent-stall debugging an order of magnitude faster than
 *  squinting at WS reconnect lines. */
export function healthSnapshot() {
  const now = Date.now();
  const ageOf = (h: ConnectionHealth): number => h.lastMessageAt > 0 ? now - h.lastMessageAt : -1;
  return {
    nowMs: now,
    subscribedPairCount: subscribedPairs.size,
    cacheSize: cache.size,
    kraken: { connected: krakenWs?.readyState === WebSocket.OPEN, ageMs: ageOf(krakenHealth), backoffMs: krakenHealth.backoffMs },
    coinbase: { connected: coinbaseWs?.readyState === WebSocket.OPEN, ageMs: ageOf(coinbaseHealth), backoffMs: coinbaseHealth.backoffMs },
    binanceUs: { connected: binanceWs?.readyState === WebSocket.OPEN, ageMs: ageOf(binanceHealth), backoffMs: binanceHealth.backoffMs },
    gemini: [...geminiSockets.entries()].map(([symbol, ws]) => ({
      symbol,
      connected: ws.readyState === WebSocket.OPEN,
      ageMs: ageOf(geminiHealth.get(symbol) ?? newHealth()),
      backoffMs: geminiHealth.get(symbol)?.backoffMs ?? BACKOFF_INITIAL_MS,
    })),
  };
}
