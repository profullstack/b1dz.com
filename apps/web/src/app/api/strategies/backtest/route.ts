/**
 * POST /api/strategies/backtest
 *
 * Backtests a user-authored TSP document for the builder wizard. Validates +
 * compiles the doc, then replays its own buy/sell signals long-only over daily
 * bars for a chosen time frame, scoring crypto and equities separately with a
 * bankroll (compounding) model.
 *
 * Read-only; never trades. Auth required.
 *
 * Body: { definition, classes?, bankroll?, timeframe? }
 *
 * Price data:
 *   - Crypto → Kraken daily OHLC via @b1dz/source-crypto-trade's
 *     fetchHistoricalCandles (keyless; the same path the daemon + /api/backtest
 *     use, proven to work from Railway).
 *   - Equities → Yahoo Finance (best-effort). Yahoo is frequently blocked from
 *     datacenter IPs, so equities may return no data until a broker market-data
 *     key (e.g. Alpaca) is wired in; crypto is unaffected.
 */
import type { NextRequest } from 'next/server';
import { fetchHistoricalCandles } from '@b1dz/source-crypto-trade';
import { tsp } from '@b1dz/source-strategies';
import { authenticate, unauthorized } from '@/lib/api-auth';
import {
  runStrategyBacktest,
  TIMEFRAMES,
  DEFAULT_TIMEFRAME,
  type AssetClass,
  type DailyClose,
  type FetchCloses,
  type TimeframeLabel,
} from '@/lib/strategy-backtest-runner';

export const maxDuration = 60;

const DAY_MS = 24 * 60 * 60 * 1000;
const VALID_CLASSES: AssetClass[] = ['crypto', 'equity'];
const TF_LABELS = TIMEFRAMES.map((t) => t.label) as TimeframeLabel[];

interface BacktestBody {
  definition?: unknown;
  classes?: string[];
  bankroll?: number;
  timeframe?: string;
}

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

/**
 * Route closes by asset class: crypto via Kraken (reliable from Railway),
 * equities via Yahoo best-effort. Returns [] if the source fails.
 */
const fetchCloses: FetchCloses = async (symbol, startMs, endMs) => {
  const isCrypto = symbol.includes('-USD');
  try {
    return isCrypto ? await fetchCryptoCloses(symbol, startMs, endMs) : await fetchYahoo(symbol, startMs, endMs);
  } catch (err) {
    console.warn(`[backtest] no price data for ${symbol} (${isCrypto ? 'kraken' : 'yahoo'}): ${(err as Error).message}`);
    return [];
  }
};

export async function POST(req: NextRequest) {
  const auth = await authenticate(req);
  if (!auth) return unauthorized();

  const body = (await req.json().catch(() => ({}))) as BacktestBody;

  const validation = tsp.validateDefinition(body.definition);
  if (!validation.ok) {
    return Response.json({ error: 'invalid strategy definition', details: validation.errors }, { status: 400 });
  }
  let plugin;
  try {
    plugin = tsp.compile(body.definition);
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }

  const classes = Array.isArray(body.classes)
    ? body.classes.filter((c): c is AssetClass => VALID_CLASSES.includes(c as AssetClass))
    : VALID_CLASSES;
  if (classes.length === 0) {
    return Response.json({ error: `classes must be a subset of ${VALID_CLASSES.join(', ')}` }, { status: 400 });
  }
  const bankroll = Math.max(1, Math.min(10_000_000, Number(body.bankroll ?? 1000) || 1000));
  const timeframe: TimeframeLabel = TF_LABELS.includes(body.timeframe as TimeframeLabel)
    ? (body.timeframe as TimeframeLabel)
    : DEFAULT_TIMEFRAME;

  const result = await runStrategyBacktest(plugin, { classes, bankroll, timeframe, fetchCloses });

  return Response.json({ strategy: { id: plugin.manifest.id, name: plugin.manifest.name }, ...result });
}
