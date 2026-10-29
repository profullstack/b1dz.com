/**
 * User-authored TSP strategies the user has switched on for live trading.
 *
 * The web app installs a saved or published strategy as a
 * user_installed_plugins row with plugin_id `tsp:<user_strategies.id>`; the
 * Settings → Plugins toggle flips it between active and disabled. Workers ask
 * here for the compiled plugins and, when the user has any for their asset
 * class, run those INSTEAD of the built-in set, so the user's own logic drives
 * entries and exits. Every downstream risk gate (sizing, PDT, the live
 * execution switches) still applies; strategies stay signals-only.
 *
 * Cached per user for CACHE_TTL_MS, so toggling in the UI takes effect within
 * a minute without a daemon restart.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { StrategyPlugin } from '@b1dz/core';
import { tsp } from '@b1dz/source-strategies';

export const TSP_PLUGIN_PREFIX = 'tsp:';
const CACHE_TTL_MS = 60_000;

export type StrategyAssetClass = 'crypto' | 'equity';

export interface LoadedUserStrategy {
  id: string;
  name: string;
  assetClasses: StrategyAssetClass[];
  plugin: StrategyPlugin;
}

interface StrategyRow {
  id: string;
  user_id: string;
  name: string;
  definition: unknown;
  asset_classes: string[] | null;
  visibility: string;
}

const cache = new Map<string, { at: number; strategies: LoadedUserStrategy[] }>();

/** Compile the rows a user may run: their own, or anyone's published ones. */
export function compileUserStrategies(userId: string, rows: StrategyRow[]): LoadedUserStrategy[] {
  const out: LoadedUserStrategy[] = [];
  for (const row of rows) {
    if (row.user_id !== userId && row.visibility !== 'published') continue;
    try {
      const plugin = tsp.compile(row.definition);
      const classes = (row.asset_classes ?? []).filter((c): c is StrategyAssetClass => c === 'crypto' || c === 'equity');
      out.push({ id: row.id, name: row.name, assetClasses: classes, plugin });
    } catch (e) {
      console.warn(`[user-strategies] skip ${row.id} for ${userId.slice(0, 8)}…: ${(e as Error).message}`);
    }
  }
  return out;
}

/** A strategy with no declared asset classes runs everywhere. */
export function forAssetClass(strategies: LoadedUserStrategy[], cls: StrategyAssetClass): LoadedUserStrategy[] {
  return strategies.filter((s) => s.assetClasses.length === 0 || s.assetClasses.includes(cls));
}

/**
 * Several strategies as one: the strongest signal wins (null when none).
 *
 * Every signal comes out at full strength. The builder's backtest trades every
 * signal a strategy emits, and the workers only use strength as an on/off
 * threshold (crypto ENTRY_MIN_SCORE defaults to 0.75; an RSI template rarely
 * scores that), so passing raw strengths through would make a strategy that
 * backtested fine sit idle live. Stops, sizing and session/PDT gates still apply.
 */
export function combineStrategies(strategies: LoadedUserStrategy[]): Pick<StrategyPlugin, 'evaluate'> & { id: string } {
  return {
    id: `user:${strategies.map((s) => s.plugin.manifest.id).join('+')}`,
    evaluate(snap, history) {
      let best: ReturnType<StrategyPlugin['evaluate']> = null;
      for (const s of strategies) {
        const sig = s.plugin.evaluate(snap, history);
        if (sig && (!best || sig.strength > best.strength)) best = sig;
      }
      return best && { ...best, strength: 1, reason: `${best.reason} (your strategy)` };
    },
  };
}

export async function loadUserStrategies(supabase: SupabaseClient, userId: string): Promise<LoadedUserStrategy[]> {
  const hit = cache.get(userId);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.strategies;

  let strategies: LoadedUserStrategy[] = hit?.strategies ?? [];
  try {
    const { data: installs, error } = await supabase
      .from('user_installed_plugins')
      .select('plugin_id')
      .eq('user_id', userId)
      .eq('status', 'active')
      .like('plugin_id', `${TSP_PLUGIN_PREFIX}%`);
    if (error) throw new Error(error.message);
    const ids = (installs ?? []).map((r: { plugin_id: string }) => r.plugin_id.slice(TSP_PLUGIN_PREFIX.length));
    if (ids.length === 0) {
      strategies = [];
    } else {
      const { data: rows, error: rowsErr } = await supabase
        .from('user_strategies')
        .select('id, user_id, name, definition, asset_classes, visibility')
        .in('id', ids);
      if (rowsErr) throw new Error(rowsErr.message);
      strategies = compileUserStrategies(userId, (rows ?? []) as StrategyRow[]);
    }
  } catch (e) {
    // Keep the last good set rather than silently falling back to built-ins mid-session.
    console.warn(`[user-strategies] load failed for ${userId.slice(0, 8)}…: ${(e as Error).message}`);
  }
  cache.set(userId, { at: Date.now(), strategies });
  return strategies;
}
