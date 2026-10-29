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
 *   - Equities → nichedb.dev's `markets` history (when NICHEDB_MARKETS=1 and
 *     it holds a fresh window covering the request; keyless, one request per
 *     symbol), then Alpaca daily bars (when ALPACA_API_KEY_ID/SECRET are set),
 *     falling back to Yahoo best-effort. Yahoo is frequently blocked from
 *     datacenter IPs, so without nichedb or Alpaca keys equities may return
 *     no data; crypto is unaffected.
 */
import type { NextRequest } from 'next/server';
import { tsp } from '@b1dz/source-strategies';
import { authenticate, unauthorized } from '@/lib/api-auth';
import { fetchCloses } from '@/lib/strategy-closes';
import {
  runStrategyBacktest,
  TIMEFRAMES,
  DEFAULT_TIMEFRAME,
  type AssetClass,
  type TimeframeLabel,
} from '@/lib/strategy-backtest-runner';

export const maxDuration = 60;

const VALID_CLASSES: AssetClass[] = ['crypto', 'equity'];
const TF_LABELS = TIMEFRAMES.map((t) => t.label) as TimeframeLabel[];

interface BacktestBody {
  definition?: unknown;
  classes?: string[];
  bankroll?: number;
  timeframe?: string;
}

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
