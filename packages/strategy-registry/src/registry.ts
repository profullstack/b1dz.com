import type { SupabaseClient } from '@supabase/supabase-js';
import type { CostModel } from '@b1dz/source-strategies';
import type { GauntletReport } from '@b1dz/strategy-validation';
import { tsp } from '@b1dz/source-strategies';

export type RegistryStatus = 'gauntlet_passed' | 'forward_running' | 'min_trl_reached' | 'listed' | 'rejected' | 'archived';

export interface RegistryRow {
  id: string;
  user_id: string;
  candidate_id: string;
  tsp_doc: tsp.TradingStrategyDefinition;
  compiled: boolean;
  status: RegistryStatus;
  gauntlet_report: GauntletReport;
  cost_model: CostModel;
  listed_at: string | null;
  rejected_at: string | null;
  archived_at: string | null;
  created_at: string;
}

export interface ForwardTradeRow {
  id: string;
  strategy_id: string;
  user_id: string;
  entry_ts: string;
  exit_ts: string | null;
  trade_json: Record<string, unknown>;
  regime_at_entry: string | null;
  recorded_at: string;
}

export async function register(
  supabase: SupabaseClient,
  userId: string,
  candidateId: string,
  tspDoc: tsp.TradingStrategyDefinition,
  gauntletReport: GauntletReport,
  costModel: CostModel,
): Promise<RegistryRow> {
  const { data, error } = await supabase.from('strategy_registry').insert({
    user_id: userId,
    candidate_id: candidateId,
    tsp_doc: tspDoc,
    compiled: true,
    status: 'gauntlet_passed',
    gauntlet_report: gauntletReport,
    cost_model: costModel,
  }).select().single();
  if (error) throw error;
  return data as RegistryRow;
}

export async function listByUser(
  supabase: SupabaseClient,
  userId: string,
  status?: string,
): Promise<RegistryRow[]> {
  let q = supabase
    .from('strategy_registry')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });

  if (status) q = q.eq('status', status);

  const { data, error } = await q;
  if (error) throw error;
  return data as RegistryRow[];
}

export async function listForwardRunning(
  supabase: SupabaseClient,
): Promise<RegistryRow[]> {
  const { data, error } = await supabase
    .from('strategy_registry')
    .select('*')
    .in('status', ['gauntlet_passed', 'forward_running']);

  if (error) throw error;
  return data as RegistryRow[];
}

export async function setStatus(
  supabase: SupabaseClient,
  strategyId: string,
  status: string,
): Promise<void> {
  const { error } = await supabase
    .from('strategy_registry')
    .update({ status })
    .eq('id', strategyId);

  if (error) throw error;
}

export async function setListed(
  supabase: SupabaseClient,
  strategyId: string,
): Promise<void> {
  const { error } = await supabase
    .from('strategy_registry')
    .update({ status: 'listed', listed_at: new Date().toISOString() })
    .eq('id', strategyId);

  if (error) throw error;
}

export async function insertForwardTrade(
  supabase: SupabaseClient,
  strategyId: string,
  userId: string,
  entryTs: string,
  trade: Record<string, unknown>,
  regimeAtEntry?: string,
): Promise<ForwardTradeRow> {
  const { data, error } = await supabase
    .from('forward_trades')
    .insert({
      strategy_id: strategyId,
      user_id: userId,
      entry_ts: entryTs,
      trade_json: trade,
      regime_at_entry: regimeAtEntry ?? null,
    })
    .select()
    .single();

  if (error) throw error;
  return data as ForwardTradeRow;
}

export async function closeForwardTrade(
  supabase: SupabaseClient,
  tradeId: string,
  exitTs: string,
  updatedTrade: Record<string, unknown>,
): Promise<ForwardTradeRow> {
  const { data, error } = await supabase
    .from('forward_trades')
    .update({
      exit_ts: exitTs,
      trade_json: updatedTrade,
    })
    .eq('id', tradeId)
    .select()
    .single();

  if (error) throw error;
  return data as ForwardTradeRow;
}

export async function forwardTradeHistory(
  supabase: SupabaseClient,
  strategyId: string,
): Promise<ForwardTradeRow[]> {
  const { data, error } = await supabase
    .from('forward_trades')
    .select('*')
    .eq('strategy_id', strategyId)
    .order('entry_ts', { ascending: true });

  if (error) throw error;
  return data as ForwardTradeRow[];
}

export async function countOpenTrades(
  supabase: SupabaseClient,
  strategyId: string,
): Promise<number> {
  const { count, error } = await supabase
    .from('forward_trades')
    .select('*', { count: 'exact', head: true })
    .eq('strategy_id', strategyId)
    .is('exit_ts', null);

  if (error) throw error;
  return count ?? 0;
}
