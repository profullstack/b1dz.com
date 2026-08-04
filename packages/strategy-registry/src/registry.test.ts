import { describe, it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { GauntletReport } from '@b1dz/strategy-validation';
import type { CostModel } from '@b1dz/source-strategies';
import { tsp } from '@b1dz/source-strategies';
import {
  register,
  listByUser,
  listForwardRunning,
  setListed,
  setStatus,
  insertForwardTrade,
  closeForwardTrade,
  forwardTradeHistory,
  countOpenTrades,
  type RegistryRow,
  type ForwardTradeRow,
} from './registry.js';

const ZERO_COSTS: CostModel = {
  feeBps: 0,
  slippageBps: 0,
  assumedHalfSpreadBps: 0,
  perOrderUsd: 0,
};

function makeReport(overrides: Partial<GauntletReport> = {}): GauntletReport {
  return {
    passed: true,
    candidateId: 'test-strat',
    validationErrors: [],
    inSampleGates: [],
    outOfSampleGates: [],
    walkForward: [],
    deflatedSharpe: null,
    robustness: null,
    regimeCoverageResult: null,
    duplicates: [],
    inSampleSummary: null,
    outOfSampleSummary: null,
    costModel: ZERO_COSTS,
    generatedAt: '2026-08-01T00:00:00Z',
    advisoryGates: [],
    ...overrides,
  };
}

const SAMPLE_DOC: tsp.TradingStrategyDefinition = {
  tsp: '0.1',
  id: 'c1',
  name: 'test',
  assetClasses: ['crypto'],
  definition: {
    kind: 'rules',
    rules: [],
  },
};

interface InnerQuery {
  select: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  eq: ReturnType<typeof vi.fn>;
  in: ReturnType<typeof vi.fn>;
  order: ReturnType<typeof vi.fn>;
  is: ReturnType<typeof vi.fn>;
  single: ReturnType<typeof vi.fn>;
  then: (onFulfilled: (v: unknown) => void, onRejected?: (e: unknown) => void) => void;
  __result: { data?: unknown; error?: unknown; count?: number } | null;
}

function mockInner(): InnerQuery {
  const self: InnerQuery = {
    __result: null,
  } as unknown as InnerQuery;
  self.select = vi.fn(() => self);
  self.insert = vi.fn(() => self);
  self.update = vi.fn(() => self);
  self.eq = vi.fn(() => self);
  self.in = vi.fn(() => self);
  self.order = vi.fn(() => self);
  self.is = vi.fn(() => self);
  self.single = vi.fn(() => self);
  self.then = (onFulfilled: (v: unknown) => void, onRejected?: (e: unknown) => void) => {
    if (self.__result) {
      onFulfilled(self.__result);
    } else {
      onFulfilled({ data: null, error: null });
    }
  };
  return self;
}

function mockSupabase(inner: InnerQuery): SupabaseClient {
  return { from: vi.fn(() => inner) } as unknown as SupabaseClient;
}

// ── register ─────────────────────────────────────────────────────────────────

describe('register', () => {
  it('inserts a row and returns the entry', async () => {
    const inner = mockInner();
    const row: RegistryRow = {
      id: 'reg-1',
      user_id: 'u1',
      candidate_id: 'c1',
      tsp_doc: SAMPLE_DOC,
      compiled: true,
      status: 'gauntlet_passed',
      gauntlet_report: makeReport(),
      cost_model: ZERO_COSTS,
      listed_at: null,
      rejected_at: null,
      archived_at: null,
      created_at: '2026-08-01T00:00:00Z',
    };
    inner.__result = { data: row, error: null };

    const entry = await register(
      mockSupabase(inner), 'u1', 'c1',
      SAMPLE_DOC, makeReport(), ZERO_COSTS,
    );

    expect(inner.insert).toHaveBeenCalledWith({
      user_id: 'u1',
      candidate_id: 'c1',
      tsp_doc: SAMPLE_DOC,
      compiled: true,
      status: 'gauntlet_passed',
      gauntlet_report: makeReport(),
      cost_model: ZERO_COSTS,
    });
    expect(entry.id).toBe('reg-1');
    expect(entry.status).toBe('gauntlet_passed');
  });

  it('propagates errors', async () => {
    const inner = mockInner();
    inner.__result = { data: null, error: { message: 'dup key' } };
    await expect(
      register(mockSupabase(inner), 'u1', 'c1', SAMPLE_DOC, makeReport(), ZERO_COSTS),
    ).rejects.toEqual({ message: 'dup key' });
  });
});

// ── listByUser ───────────────────────────────────────────────────────────────

describe('listByUser', () => {
  it('lists entries for a user, newest first', async () => {
    const rows: RegistryRow[] = [
      { id: 'r1', user_id: 'u1', candidate_id: 'c1', tsp_doc: SAMPLE_DOC, compiled: true, status: 'gauntlet_passed', gauntlet_report: makeReport(), cost_model: ZERO_COSTS, listed_at: null, rejected_at: null, archived_at: null, created_at: '2026-08-01T00:00:00Z' },
      { id: 'r2', user_id: 'u1', candidate_id: 'c2', tsp_doc: SAMPLE_DOC, compiled: true, status: 'listed', gauntlet_report: makeReport(), cost_model: ZERO_COSTS, listed_at: '2026-08-02T00:00:00Z', rejected_at: null, archived_at: null, created_at: '2026-08-02T00:00:00Z' },
    ];
    const inner = mockInner();
    inner.__result = { data: rows, error: null };

    const entries = await listByUser(mockSupabase(inner), 'u1');
    expect(inner.order).toHaveBeenCalledWith('created_at', { ascending: false });
    expect(entries).toHaveLength(2);
    expect(entries[1]!.status).toBe('listed');
  });

  it('filters by status when provided', async () => {
    const inner = mockInner();
    inner.__result = { data: [], error: null };

    await listByUser(mockSupabase(inner), 'u1', 'forward_running');
    expect(inner.eq).toHaveBeenCalledWith('status', 'forward_running');
  });
});

// ── listForwardRunning ───────────────────────────────────────────────────────

describe('listForwardRunning', () => {
  it('selects strategies with status gauntlet_passed or forward_running', async () => {
    const inner = mockInner();
    const rows: RegistryRow[] = [
      { id: 'r1', user_id: 'u1', candidate_id: 'c1', tsp_doc: SAMPLE_DOC, compiled: true, status: 'forward_running', gauntlet_report: makeReport(), cost_model: ZERO_COSTS, listed_at: null, rejected_at: null, archived_at: null, created_at: '2026-08-01T00:00:00Z' },
    ];
    inner.__result = { data: rows, error: null };

    const entries = await listForwardRunning(mockSupabase(inner));
    expect(inner.in).toHaveBeenCalledWith('status', ['gauntlet_passed', 'forward_running']);
    expect(entries).toHaveLength(1);
  });
});

// ── setListed ────────────────────────────────────────────────────────────────

describe('setListed', () => {
  it('updates status to listed and sets listed_at', async () => {
    const inner = mockInner();
    inner.__result = { data: null, error: null };

    await setListed(mockSupabase(inner), 'reg-1');
    expect(inner.eq).toHaveBeenCalledWith('id', 'reg-1');
    const callArg = (inner.update as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<string, unknown>;
    expect(callArg.status).toBe('listed');
    expect(typeof callArg.listed_at).toBe('string');
  });
});

// ── setStatus ────────────────────────────────────────────────────────────────

describe('setStatus', () => {
  it('updates status to forward_running', async () => {
    const inner = mockInner();
    inner.__result = { data: null, error: null };

    await setStatus(mockSupabase(inner), 'reg-1', 'forward_running');
    expect(inner.eq).toHaveBeenCalledWith('id', 'reg-1');
    const callArg = (inner.update as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<string, unknown>;
    expect(callArg.status).toBe('forward_running');
  });

  it('updates status to min_trl_reached', async () => {
    const inner = mockInner();
    inner.__result = { data: null, error: null };

    await setStatus(mockSupabase(inner), 'reg-1', 'min_trl_reached');
    const callArg = (inner.update as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<string, unknown>;
    expect(callArg.status).toBe('min_trl_reached');
  });
});

// ── forward trades ───────────────────────────────────────────────────────────

describe('insertForwardTrade', () => {
  it('inserts a trade with explicit entry_ts', async () => {
    const inner = mockInner();
    const row: ForwardTradeRow = {
      id: 'ft-1', strategy_id: 'reg-1', user_id: 'u1',
      entry_ts: '2026-08-01T00:00:00.000Z', exit_ts: null,
      trade_json: { profit: 5 }, regime_at_entry: 'trend', recorded_at: '2026-08-01T00:00:00.000Z',
    };
    inner.__result = { data: row, error: null };

    const trade = await insertForwardTrade(
      mockSupabase(inner), 'reg-1', 'u1',
      '2026-08-01T00:00:00.000Z',
      { profit: 5 },
      'trend',
    );
    expect(inner.insert).toHaveBeenCalledWith({
      strategy_id: 'reg-1',
      user_id: 'u1',
      entry_ts: '2026-08-01T00:00:00.000Z',
      trade_json: { profit: 5 },
      regime_at_entry: 'trend',
    });
    expect(trade.id).toBe('ft-1');
    expect(trade.exit_ts).toBeNull();
  });
});

describe('closeForwardTrade', () => {
  it('updates exit_ts and trade_json', async () => {
    const inner = mockInner();
    const row: ForwardTradeRow = {
      id: 'ft-1', strategy_id: 'reg-1', user_id: 'u1',
      entry_ts: '2026-08-01T00:00:00.000Z', exit_ts: '2026-08-02T00:00:00.000Z',
      trade_json: { profit: 5 },
      regime_at_entry: 'trend',
      recorded_at: '2026-08-01T00:00:00.000Z',
    };
    inner.__result = { data: row, error: null };

    const trade = await closeForwardTrade(
      mockSupabase(inner),
      'ft-1',
      '2026-08-02T00:00:00.000Z',
      { profit: 5 },
    );
    const callArg = (inner.update as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<string, unknown>;
    expect(callArg.exit_ts).toBe('2026-08-02T00:00:00.000Z');
    expect(callArg.trade_json).toEqual({ profit: 5 });
    expect(trade.exit_ts).not.toBeNull();
  });
});

describe('forwardTradeHistory', () => {
  it('returns trades ordered by entry_ts ascending', async () => {
    const inner = mockInner();
    const rows: ForwardTradeRow[] = [
      { id: 'ft-1', strategy_id: 'reg-1', user_id: 'u1', entry_ts: '2026-08-01T00:00:00Z', exit_ts: null, trade_json: {}, regime_at_entry: null, recorded_at: '2026-08-01T00:00:00Z' },
      { id: 'ft-2', strategy_id: 'reg-1', user_id: 'u1', entry_ts: '2026-08-02T00:00:00Z', exit_ts: null, trade_json: {}, regime_at_entry: null, recorded_at: '2026-08-02T00:00:00Z' },
    ];
    inner.__result = { data: rows, error: null };

    const trades = await forwardTradeHistory(mockSupabase(inner), 'reg-1');
    expect(inner.order).toHaveBeenCalledWith('entry_ts', { ascending: true });
    expect(trades).toHaveLength(2);
  });
});

describe('countOpenTrades', () => {
  it('counts rows where exit_ts is null', async () => {
    const inner = mockInner();
    inner.__result = { count: 3, error: null };

    const n = await countOpenTrades(mockSupabase(inner), 'reg-1');
    expect(inner.select).toHaveBeenCalledWith('*', { count: 'exact', head: true });
    expect(inner.is).toHaveBeenCalledWith('exit_ts', null);
    expect(n).toBe(3);
  });

  it('returns 0 when count is null', async () => {
    const inner = mockInner();
    inner.__result = { count: null, error: null };

    const n = await countOpenTrades(mockSupabase(inner), 'reg-1');
    expect(n).toBe(0);
  });
});
