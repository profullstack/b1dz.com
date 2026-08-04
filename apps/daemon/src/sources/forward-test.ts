import type { SourceWorker, UserContext } from '../types.js';
import { replayStrategy, tsp, type CostModel, type BacktestTrade } from '@b1dz/source-strategies';
import { listForwardRunning, setStatus, insertForwardTrade, closeForwardTrade, forwardTradeHistory } from '@b1dz/strategy-registry';
import { computeMetrics, minimumTrackRecordLength } from '@b1dz/strategy-validation';
import type { MarketSnapshot } from '@b1dz/core';

const CRYPTO_BASKET = ['BTC-USD', 'ETH-USD', 'SOL-USD'];
const EQUITY_BASKET = ['SPY', 'AAPL', 'NVDA'];
const DAY_MS = 24 * 60 * 60 * 1000;

async function fetchYahooBars(symbol: string): Promise<MarketSnapshot[]> {
  const endMs = Date.now();
  const startMs = endMs - 150 * DAY_MS;
  const period1 = Math.floor(startMs / 1000);
  const period2 = Math.floor(endMs / 1000);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${period1}&period2=${period2}&interval=1d&events=history`;

  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' } });
  if (!res.ok) return [];
  const json = await res.json() as { chart?: { result?: { timestamp?: number[]; indicators?: { quote?: { close?: (number | null)[] }[] } }[] } };
  const result = json.chart?.result?.[0];
  if (!result?.timestamp) return [];
  const close = result.indicators?.quote?.[0]?.close ?? [];

  return result.timestamp
    .map((t: number, i: number) => ({ t: t * 1000, c: close[i] }))
    .filter((b: { t: number; c: number | null }): b is { t: number; c: number } => Number.isFinite(b.c))
    .sort((a: { t: number }, b: { t: number }) => a.t - b.t)
    .map((b: { t: number; c: number }) => ({
      exchange: 'yahoo',
      pair: symbol,
      bid: b.c,
      ask: b.c,
      bidSize: 1,
      askSize: 1,
      ts: b.t,
      assetClass: symbol.includes('-USD') ? 'crypto' as const : 'equity' as const,
    }));
}

export const forwardTestWorker: SourceWorker = {
  id: 'forward-test',
  pollIntervalMs: 60_000,

  hasCredentials(_payload: Record<string, unknown>) {
    return true;
  },

  async tick(ctx: UserContext) {
    const strategies = await listForwardRunning(ctx.supabase);

    for (const s of strategies) {
      if (s.status === 'gauntlet_passed') {
        await setStatus(ctx.supabase, s.id, 'forward_running');
      }

      const plugin = tsp.compile(s.tsp_doc);
      const costModel = s.cost_model as CostModel;

      const assetClasses = s.tsp_doc.assetClasses?.length ? s.tsp_doc.assetClasses : ['crypto', 'equity'];

      for (const ac of assetClasses) {
        const basket = ac === 'crypto' ? CRYPTO_BASKET : EQUITY_BASKET;

        for (const symbol of basket) {
          const snaps = await fetchYahooBars(symbol);
          if (!snaps.length) continue;

          const trades = replayStrategy(plugin, snaps, { amountPerEntry: 100, costs: costModel });

          const existing = await forwardTradeHistory(ctx.supabase, s.id);
          const existingEntries = new Set(existing.map((t) => t.entry_ts));

          for (const trade of trades) {
            const entryTsStr = new Date(trade.entryTs).toISOString();
            if (!existingEntries.has(entryTsStr)) {
              await insertForwardTrade(ctx.supabase, s.id, s.user_id, entryTsStr, trade as unknown as Record<string, unknown>);
            }
          }

          const openTrades = existing.filter((t) => !t.exit_ts);
          const latestBar = snaps[snaps.length - 1]!;
          for (const ot of openTrades) {
            const otTrade = ot.trade_json as Record<string, number>;
            if (otTrade.exitTs && otTrade.exitTs <= latestBar.ts) {
              await closeForwardTrade(ctx.supabase, ot.id, new Date(otTrade.exitTs).toISOString(), ot.trade_json);
            }
          }
        }
      }

      const allTrades = await forwardTradeHistory(ctx.supabase, s.id);
      const closedTrades = allTrades.filter((t) => t.exit_ts);
      if (closedTrades.length >= 30) {
        const metrics = computeMetrics(closedTrades.map((t) => t.trade_json as unknown as BacktestTrade));
        const minTrl = minimumTrackRecordLength({
          observedSharpe: metrics.sharpePerTrade,
          benchmarkSharpe: s.gauntlet_report?.deflatedSharpe?.expectedMaxSharpe ?? 0,
        });
        if (Number.isFinite(minTrl) && closedTrades.length >= minTrl) {
          await setStatus(ctx.supabase, s.id, 'min_trl_reached');
        }
      }
    }

    await ctx.savePayload({ lastTickAt: new Date().toISOString(), strategyCount: strategies.length });
  },
};
