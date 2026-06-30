/**
 * POST /api/strategies/backtest
 *
 * Backtests a user-authored TSP (Trading Strategy Protocol) document for the
 * builder wizard. Validates + compiles the doc to a StrategyPlugin, then replays
 * its own buy/sell signals long-only over Yahoo daily bars, scoring crypto and
 * equities separately so the author can see which asset class the strategy suits.
 *
 * Read-only — never executes trades. Auth required (prevents the route being an
 * open Yahoo proxy / compute sink).
 *
 * Body: {
 *   definition: <TSP document>,
 *   classes?: ('crypto'|'equity')[],   // default both
 *   amount?: number,                   // dollars per entry, default 100
 * }
 */
import type { NextRequest } from 'next/server';
import { tsp } from '@b1dz/source-strategies';
import { authenticate, unauthorized } from '@/lib/api-auth';
import {
  runStrategyBacktest,
  type AssetClass,
  type DailyClose,
  type FetchCloses,
} from '@/lib/strategy-backtest-runner';

export const maxDuration = 60;

const DAY_MS = 24 * 60 * 60 * 1000;
const VALID_CLASSES: AssetClass[] = ['crypto', 'equity'];

interface BacktestBody {
  definition?: unknown;
  classes?: string[];
  amount?: number;
}

/** Yahoo Finance free chart API — daily closes. */
const fetchYahooCloses: FetchCloses = async (symbol, startMs, endMs) => {
  const period1 = Math.floor((startMs - 7 * DAY_MS) / 1000);
  const period2 = Math.floor((endMs + 7 * DAY_MS) / 1000);
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
    `?period1=${period1}&period2=${period2}&interval=1d&events=history`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Yahoo HTTP ${res.status} for ${symbol}`);
  const json = (await res.json()) as {
    chart?: { result?: { timestamp?: number[]; indicators?: { quote?: { close?: (number | null)[] }[] } }[] };
  };
  const result = json.chart?.result?.[0];
  const ts = result?.timestamp ?? [];
  const close = result?.indicators?.quote?.[0]?.close ?? [];
  const rows: DailyClose[] = [];
  for (let i = 0; i < ts.length; i++) {
    const c = close[i];
    if (Number.isFinite(c)) rows.push({ ts: ts[i]! * 1000, close: c as number });
  }
  return rows;
};

export async function POST(req: NextRequest) {
  const auth = await authenticate(req);
  if (!auth) return unauthorized();

  const body = (await req.json().catch(() => ({}))) as BacktestBody;

  // Validate the TSP document before doing any work.
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
    ? (body.classes.filter((c): c is AssetClass => VALID_CLASSES.includes(c as AssetClass)))
    : VALID_CLASSES;
  if (classes.length === 0) {
    return Response.json({ error: `classes must be a subset of ${VALID_CLASSES.join(', ')}` }, { status: 400 });
  }
  const amount = Math.max(1, Math.min(100_000, Number(body.amount ?? 100) || 100));

  const result = await runStrategyBacktest(plugin, { classes, amount, fetchCloses: fetchYahooCloses });

  return Response.json({
    strategy: { id: plugin.manifest.id, name: plugin.manifest.name },
    ...result,
  });
}
