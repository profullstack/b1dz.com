/**
 * Daily closes for the strategy backtester, routed by asset class:
 *   - crypto → Kraken daily OHLC (keyless; works from datacenter IPs).
 *   - equities → nichedb (when NICHEDB_MARKETS=1) → Alpaca (when keys set) → Yahoo.
 * Shared by POST /api/strategies/backtest and the publish route, which reruns
 * the backtest server-side so store listings carry numbers nobody typed in.
 */
import { fetchHistoricalCandles } from '@b1dz/source-crypto-trade';
import { createNichedbClient, fetchDailyBars, nichedbEnabled } from '@b1dz/source-nichedb';
import type { DailyClose, FetchCloses } from '@/lib/strategy-backtest-runner';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Yahoo Finance free chart API — daily closes. Often blocked on datacenters. */
async function fetchYahoo(symbol: string, startMs: number, endMs: number): Promise<DailyClose[]> {
  const period1 = Math.floor((startMs - 7 * DAY_MS) / 1000);
  const period2 = Math.floor((endMs + 7 * DAY_MS) / 1000);
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
    `?period1=${period1}&period2=${period2}&interval=1d&events=history`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Yahoo HTTP ${res.status}`);
  const json = (await res.json()) as {
    chart?: { result?: { timestamp?: number[]; indicators?: { quote?: { close?: (number | null)[] }[] } }[] };
  };
  const result = json.chart?.result?.[0];
  const ts = result?.timestamp ?? [];
  const close = result?.indicators?.quote?.[0]?.close ?? [];
  const rows: DailyClose[] = [];
  for (let i = 0; i < ts.length; i++) {
    if (Number.isFinite(close[i])) rows.push({ ts: ts[i]! * 1000, close: close[i] as number });
  }
  if (rows.length === 0) throw new Error('Yahoo returned no rows');
  return rows;
}

/** Crypto daily closes via Kraken OHLC (keyless; works from datacenter IPs). */
async function fetchCryptoCloses(symbol: string, startMs: number, endMs: number): Promise<DailyClose[]> {
  const days = Math.ceil((endMs - startMs) / DAY_MS) + 10;
  const limit = Math.max(50, Math.min(1000, days)); // exchange caps history; long windows are truncated
  const candles = await fetchHistoricalCandles('kraken', symbol, '1d', limit);
  return candles
    .filter((c) => Number.isFinite(c.close))
    .map((c) => ({ ts: c.time, close: c.close }));
}

/** Equity daily closes via Alpaca market data. Throws if keys aren't configured. */
async function fetchAlpacaCloses(symbol: string, startMs: number, endMs: number): Promise<DailyClose[]> {
  const keyId = process.env.ALPACA_API_KEY_ID;
  const secret = process.env.ALPACA_API_SECRET_KEY;
  if (!keyId || !secret) throw new Error('Alpaca keys not configured');
  const feed = process.env.ALPACA_FEED || 'iex';
  const start = new Date(startMs - 7 * DAY_MS).toISOString().slice(0, 10);
  const end = new Date(endMs).toISOString().slice(0, 10);
  const url =
    `https://data.alpaca.markets/v2/stocks/${encodeURIComponent(symbol)}/bars` +
    `?timeframe=1Day&start=${start}&end=${end}&adjustment=raw&feed=${feed}&limit=1000`;
  const res = await fetch(url, { headers: { 'APCA-API-KEY-ID': keyId, 'APCA-API-SECRET-KEY': secret } });
  if (!res.ok) throw new Error(`Alpaca HTTP ${res.status}`);
  const json = (await res.json()) as { bars?: { t: string; c: number }[] };
  const rows = (json.bars ?? [])
    .filter((b) => Number.isFinite(b.c))
    .map((b) => ({ ts: Date.parse(b.t), close: b.c }))
    .filter((r) => Number.isFinite(r.ts));
  if (rows.length === 0) throw new Error('Alpaca returned no bars');
  return rows;
}

/**
 * Equity daily closes from nichedb's `markets` history item (400 daily bars,
 * split adjusted). Throws when nichedb has no fresh window covering the
 * request (missing symbol, last bar older than 5 days, more than 400 days
 * asked for) so the caller moves on to Alpaca and Yahoo.
 */
async function fetchNichedbCloses(symbol: string, startMs: number, endMs: number): Promise<DailyClose[]> {
  const result = await fetchDailyBars(createNichedbClient(), symbol, startMs, endMs);
  if (!result.ok) throw new Error(`nichedb ${result.reason}`);
  const rows = result.bars.map((b) => ({ ts: b.ts, close: b.close }));
  if (rows.length === 0) throw new Error('nichedb returned no rows');
  return rows;
}

/**
 * Route closes by asset class:
 *   - crypto → Kraken (reliable from Railway, keyless).
 *   - equities → nichedb (if NICHEDB_MARKETS=1) → Alpaca (if keys set) → Yahoo fallback.
 * Returns [] only if every source for that symbol fails.
 */
export const fetchCloses: FetchCloses = async (symbol, startMs, endMs) => {
  if (symbol.includes('-USD')) {
    try {
      return await fetchCryptoCloses(symbol, startMs, endMs);
    } catch (err) {
      console.warn(`[backtest] no crypto data for ${symbol} (kraken): ${(err as Error).message}`);
      return [];
    }
  }
  // Equity: nichedb when switched on, then Alpaca, then Yahoo.
  if (nichedbEnabled('NICHEDB_MARKETS')) {
    try {
      return await fetchNichedbCloses(symbol, startMs, endMs);
    } catch (err) {
      console.warn(`[backtest] nichedb cannot serve ${symbol} (${(err as Error).message}); falling back`);
    }
  }
  try {
    return await fetchAlpacaCloses(symbol, startMs, endMs);
  } catch (alpacaErr) {
    try {
      return await fetchYahoo(symbol, startMs, endMs);
    } catch (yahooErr) {
      console.warn(`[backtest] no equity data for ${symbol}: alpaca=${(alpacaErr as Error).message} yahoo=${(yahooErr as Error).message}`);
      return [];
    }
  }
};
