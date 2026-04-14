/**
 * Supabase/Postgres-backed event channel. This is the production impl
 * intended for multi-process observer + daemon deployments.
 *
 * Claim contention handling (PRD §11A.2 "durable internal event channel"):
 * Supabase client-side has no native SKIP LOCKED. We implement an
 * at-most-once claim by transitioning status pending -> claimed with a
 * conditional update gated on the still-pending row. Two workers
 * racing for the same row will have exactly one succeed; the other
 * gets zero rows back from the update. That's strictly weaker than
 * `FOR UPDATE SKIP LOCKED` (can starve under heavy contention) but
 * avoids the RPC round-trip and works for MVP scale.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Opportunity } from '@b1dz/venue-types';
import type {
  EventChannel,
  QueuedOpportunity,
  PublishOptions,
  ClaimOptions,
  OpportunityStatus,
} from './types.js';

interface Row {
  id: string;
  user_id: string;
  status: OpportunityStatus;
  claimed_by: string | null;
  claimed_at: string | null;
  resolved_at: string | null;
  resolved_reason: string | null;
  created_at: string;
  expires_at: string;
  opportunity_id: string;
  buy_venue: string;
  sell_venue: string;
  buy_chain: string | null;
  sell_chain: string | null;
  asset: string;
  size_usd: number | string;
  gross_edge_usd: number | string;
  total_fees_usd: number | string;
  total_gas_usd: number | string;
  total_slippage_usd: number | string;
  risk_buffer_usd: number | string;
  expected_net_usd: number | string;
  expected_net_bps: number | string;
  confidence: number | string;
  executable: boolean;
  blockers: string[];
  category: Opportunity['category'];
  buy_quote: Opportunity['buyQuote'];
  sell_quote: Opportunity['sellQuote'];
  observed_at: string;
}

function rowToQueued(row: Row): QueuedOpportunity {
  const opportunity: Opportunity = {
    id: row.opportunity_id,
    buyVenue: row.buy_venue,
    sellVenue: row.sell_venue,
    buyChain: row.buy_chain,
    sellChain: row.sell_chain,
    asset: row.asset,
    size: String(row.size_usd),
    grossEdgeUsd: Number(row.gross_edge_usd),
    totalFeesUsd: Number(row.total_fees_usd),
    totalGasUsd: Number(row.total_gas_usd),
    totalSlippageUsd: Number(row.total_slippage_usd),
    riskBufferUsd: Number(row.risk_buffer_usd),
    expectedNetUsd: Number(row.expected_net_usd),
    expectedNetBps: Number(row.expected_net_bps),
    confidence: Number(row.confidence),
    blockers: row.blockers ?? [],
    executable: row.executable,
    category: row.category,
    buyQuote: row.buy_quote,
    sellQuote: row.sell_quote,
    observedAt: new Date(row.observed_at).getTime(),
  };
  return {
    queueId: row.id,
    status: row.status,
    claimedBy: row.claimed_by,
    claimedAt: row.claimed_at ? new Date(row.claimed_at).getTime() : null,
    resolvedAt: row.resolved_at ? new Date(row.resolved_at).getTime() : null,
    resolvedReason: row.resolved_reason,
    createdAt: new Date(row.created_at).getTime(),
    expiresAt: new Date(row.expires_at).getTime(),
    opportunity,
  };
}

export interface SupabaseChannelOptions {
  userId: string;
  defaultTtlMs?: number;
}

export class SupabaseEventChannel implements EventChannel {
  private readonly client: SupabaseClient;
  private readonly userId: string;
  private readonly defaultTtlMs: number;

  constructor(client: SupabaseClient, opts: SupabaseChannelOptions) {
    this.client = client;
    this.userId = opts.userId;
    this.defaultTtlMs = opts.defaultTtlMs ?? 5_000;
  }

  async publish(opp: Opportunity, opts: PublishOptions = {}): Promise<QueuedOpportunity> {
    const expiresAt = new Date(Date.now() + (opts.ttlMs ?? this.defaultTtlMs)).toISOString();
    const { data, error } = await this.client
      .from('opportunities_v2')
      .insert({
        user_id: this.userId,
        status: 'pending',
        opportunity_id: opp.id,
        buy_venue: opp.buyVenue,
        sell_venue: opp.sellVenue,
        buy_chain: opp.buyChain,
        sell_chain: opp.sellChain,
        asset: opp.asset,
        size_usd: Number(opp.size),
        gross_edge_usd: opp.grossEdgeUsd,
        total_fees_usd: opp.totalFeesUsd,
        total_gas_usd: opp.totalGasUsd,
        total_slippage_usd: opp.totalSlippageUsd,
        risk_buffer_usd: opp.riskBufferUsd,
        expected_net_usd: opp.expectedNetUsd,
        expected_net_bps: opp.expectedNetBps,
        confidence: opp.confidence,
        executable: opp.executable,
        blockers: opp.blockers,
        category: opp.category,
        buy_quote: opp.buyQuote,
        sell_quote: opp.sellQuote,
        observed_at: new Date(opp.observedAt).toISOString(),
        expires_at: expiresAt,
      })
      .select('*')
      .single();
    if (error || !data) throw new Error(`publish failed: ${error?.message ?? 'no row'}`);
    return rowToQueued(data as unknown as Row);
  }

  async claim(opts: ClaimOptions = {}): Promise<QueuedOpportunity[]> {
    const limit = Math.max(1, opts.limit ?? 1);
    const claimer = opts.claimer ?? 'default';
    const nowIso = new Date().toISOString();

    // Get a candidate set first. The follow-up update is conditional on
    // status='pending' so we don't double-claim even without SKIP LOCKED.
    const { data: candidates, error: selErr } = await this.client
      .from('opportunities_v2')
      .select('id')
      .eq('user_id', this.userId)
      .eq('status', 'pending')
      .gt('expires_at', nowIso)
      .order('created_at', { ascending: true })
      .limit(limit);
    if (selErr) throw new Error(`claim select failed: ${selErr.message}`);
    const ids = (candidates ?? []).map((r) => (r as { id: string }).id);
    if (ids.length === 0) return [];

    const { data: claimed, error: updErr } = await this.client
      .from('opportunities_v2')
      .update({ status: 'claimed', claimed_by: claimer, claimed_at: nowIso })
      .in('id', ids)
      .eq('status', 'pending')
      .select('*');
    if (updErr) throw new Error(`claim update failed: ${updErr.message}`);
    return ((claimed ?? []) as unknown as Row[]).map(rowToQueued);
  }

  async resolve(
    queueId: string,
    status: Exclude<OpportunityStatus, 'pending' | 'claimed'>,
    reason: string,
  ): Promise<void> {
    const { error } = await this.client
      .from('opportunities_v2')
      .update({
        status,
        resolved_at: new Date().toISOString(),
        resolved_reason: reason,
      })
      .eq('id', queueId);
    if (error) throw new Error(`resolve failed: ${error.message}`);
  }

  async inspect(status?: OpportunityStatus): Promise<QueuedOpportunity[]> {
    let query = this.client
      .from('opportunities_v2')
      .select('*')
      .eq('user_id', this.userId)
      .order('created_at', { ascending: false })
      .limit(100);
    if (status) query = query.eq('status', status);
    const { data, error } = await query;
    if (error) throw new Error(`inspect failed: ${error.message}`);
    return ((data ?? []) as unknown as Row[]).map(rowToQueued);
  }
}
