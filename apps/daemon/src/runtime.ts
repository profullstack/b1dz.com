/**
 * Multi-user, multi-source scheduler.
 *
 * One in-memory entry per (user_id, source_id). Each entry has its own
 * setInterval so a slow tick on user A's eBay source doesn't block user B's
 * DealDash source. Source list is rescanned every `discoverIntervalMs` to
 * pick up newly-signed-up users without restart.
 *
 * Designed to run identically:
 *   - From a terminal:   `b1dzd` or `pnpm --filter @b1dz/daemon dev`
 *   - From systemd:      see apps/daemon/systemd/b1dzd.service
 *   - From Docker:       see Dockerfile (single image, two services)
 *   - From Railway:      same Docker image, set CMD=b1dzd
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  acquireRuntimeLease,
  getB1dzVersion,
  getRuntimeSourceState,
  refreshRuntimeLease,
  releaseRuntimeLease,
  setRuntimeSourceState,
} from '@b1dz/core';
import type { SourceWorker, UserContext } from './types.js';
import { SOURCES } from './registry.js';

interface ScheduledTick {
  userId: string;
  source: SourceWorker;
  timer: ReturnType<typeof setInterval>;
  running: boolean;
}

/** How often we're willing to hit the DB for a source_state row.
 *  Can be overridden with B1DZ_DB_SAVE_INTERVAL_MS for testing.
 *  See notes in makeContext() for why we throttle this. */
const DB_SAVE_INTERVAL_MS = (() => {
  const v = Number.parseInt(process.env.B1DZ_DB_SAVE_INTERVAL_MS ?? '30000', 10);
  return Number.isFinite(v) && v >= 0 ? v : 30_000;
})();

export class DaemonRuntime {
  private supabase: SupabaseClient;
  private scheduled = new Map<string, ScheduledTick>();
  private discoverTimer: ReturnType<typeof setInterval> | null = null;
  private stopping = false;
  /** Last DB upsert time per `${userId}::${sourceId}` — used to throttle
   *  the source_state writes that were blowing out the Supabase Disk IO
   *  budget. Runtime cache is still updated every tick. */
  private lastDbFlushAt = new Map<string, number>();
  /** When true for a given key, the next savePayload flushes to DB
   *  regardless of the throttle. Set during shutdown so we never lose
   *  state-of-the-world at exit. */
  private forceDbFlush = new Set<string>();

  constructor(opts: { supabaseUrl: string; supabaseSecretKey: string }) {
    this.supabase = createClient(opts.supabaseUrl, opts.supabaseSecretKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }

  async start(discoverIntervalMs = 60_000) {
    console.log(`b1dzd: version ${getB1dzVersion()}`);
    console.log(`b1dzd: starting with ${SOURCES.length} source(s) registered`);
    await this.discover();
    this.discoverTimer = setInterval(() => { void this.discover(); }, discoverIntervalMs);
    console.log('b1dzd: ready');
  }

  /** Auto-enable crypto-dca for any user who has crypto-arb enabled.
   *  DCA is env-controlled at runtime (DCA_ENABLED + DCA_* vars), so the
   *  per-user row just needs { enabled: true } to schedule the worker. */
  private async bootstrapDcaFor(userId: string): Promise<void> {
    const { data } = await this.supabase
      .from('source_state')
      .select('user_id')
      .eq('user_id', userId)
      .eq('source_id', 'crypto-dca')
      .maybeSingle();
    if (data) return;
    await this.supabase.from('source_state').upsert(
      { user_id: userId, source_id: 'crypto-dca', payload: { enabled: true }, updated_at: new Date().toISOString() },
      { onConflict: 'user_id,source_id' },
    );
    console.log(`b1dzd: auto-enabled crypto-dca for user ${userId.slice(0, 8)}…`);
  }

  /** Find every (user, source) pair that has credentials and ensure a tick is scheduled. */
  async discover() {
    if (this.stopping) return;
    // Auto-enable crypto-dca for any user who already has crypto-arb on.
    const { data: arbUsers } = await this.supabase
      .from('source_state')
      .select('user_id')
      .eq('source_id', 'crypto-arb');
    for (const row of arbUsers ?? []) {
      try { await this.bootstrapDcaFor(row.user_id as string); }
      catch (e) { console.error(`b1dzd: dca bootstrap failed: ${(e as Error).message}`); }
    }

    for (const source of SOURCES) {
      const { data, error } = await this.supabase
        .from('source_state')
        .select('user_id, payload')
        .eq('source_id', source.id);
      if (error) {
        console.error(`b1dzd: discover ${source.id} failed: ${error.message}`);
        continue;
      }
      const seenUsers = new Set<string>();
      for (const row of data ?? []) {
        const userId = row.user_id as string;
        const payload = (row.payload as Record<string, unknown>) ?? {};
        if (!source.hasCredentials(payload)) continue;
        seenUsers.add(userId);
        this.ensureScheduled(userId, source);
      }
      // Cancel any scheduled (user, source) entries whose user no longer has creds
      for (const [key, sched] of this.scheduled) {
        if (sched.source.id !== source.id) continue;
        if (!seenUsers.has(sched.userId)) {
          clearInterval(sched.timer);
          this.scheduled.delete(key);
          console.log(`b1dzd: unscheduled ${sched.userId.slice(0, 8)}…/${source.id} (creds gone)`);
        }
      }
    }
    if (this.scheduled.size === 0) {
      console.log('b1dzd: no users with credentials yet — will rescan in 60s');
    }
  }

  private ensureScheduled(userId: string, source: SourceWorker) {
    const key = `${userId}:${source.id}`;
    if (this.scheduled.has(key)) return;
    const tick = async () => {
      if (this.stopping) return;
      const sched = this.scheduled.get(key);
      if (!sched || sched.running) return;
      sched.running = true;
      const leaseTtlMs = Math.max(source.pollIntervalMs * 4, 120_000);
      const lease = await acquireRuntimeLease('daemon-tick', userId, source.id, leaseTtlMs);
      if (!lease && process.env.REDIS_URL?.trim()) {
        sched.running = false;
        return;
      }
      const renewTimer = lease
        ? setInterval(() => { void refreshRuntimeLease(lease); }, Math.max(5_000, Math.floor(leaseTtlMs / 3)))
        : null;
      let ctx: UserContext | null = null;
      try {
        ctx = await this.makeContext(userId, source.id);
        await ctx.savePayload({
          enabled: ctx.payload?.enabled ?? true,
          daemon: {
            lastTickAt: new Date().toISOString(),
            worker: source.id,
            status: 'running',
            version: getB1dzVersion(),
          },
        });
        await source.tick(ctx);
      } catch (e) {
        if (ctx) {
          await ctx.savePayload({
            enabled: ctx.payload?.enabled ?? true,
            daemon: {
              lastTickAt: new Date().toISOString(),
              worker: source.id,
              status: 'error',
              version: getB1dzVersion(),
            },
          }).catch(() => {});
        }
        console.error(`b1dzd: tick ${userId.slice(0, 8)}…/${source.id} failed: ${(e as Error).message}`);
      } finally {
        if (renewTimer) clearInterval(renewTimer);
        if (lease) await releaseRuntimeLease(lease);
        const current = this.scheduled.get(key);
        if (current) current.running = false;
      }
    };
    const timer = setInterval(tick, source.pollIntervalMs);
    this.scheduled.set(key, { userId, source, timer, running: false });
    console.log(`b1dzd: scheduled ${userId.slice(0, 8)}…/${source.id} every ${source.pollIntervalMs}ms`);
    void tick(); // first tick now
  }

  private async makeContext(userId: string, sourceId: string): Promise<UserContext> {
    const { data } = await this.supabase
      .from('source_state')
      .select('payload')
      .eq('user_id', userId)
      .eq('source_id', sourceId)
      .maybeSingle();
    const payload = (data?.payload as Record<string, unknown>) ?? {};
    const supabase = this.supabase;
    const savePayload = async (patch: Record<string, unknown>) => {
      // Runtime cache (Redis/filesystem) gets every tick. This is what
      // the TUI + API read for realtime state. It's cheap — no DB disk I/O.
      const prev = (await getRuntimeSourceState<Record<string, unknown>>(userId, sourceId)) ?? {};
      const next = { ...prev, ...patch };
      await setRuntimeSourceState(userId, sourceId, next);

      // DB upsert is throttled to DB_SAVE_INTERVAL_MS (default 30s) per
      // (userId, sourceId). Supabase's Disk IO budget is the tight
      // constraint; persisting a ~600KB payload every 2-5s exhausts the
      // compute add-on's disk budget even though the runtime cache is
      // already serving reads.
      //
      // The DB row is only used for:
      //   1. cold-start / daemon-restart recovery of long-lived state
      //      (closed trades, daily PnL baseline, open positions)
      //   2. reads by other user sessions hitting the API while the
      //      runtime cache entry has expired
      // Both tolerate up to 30s of staleness — strategy-critical state
      // (closed trade rows, baselines) already lives in a sub-object
      // that the next flush carries forward.
      const flushKey = `${userId}:${sourceId}`;
      const now = Date.now();
      const last = this.lastDbFlushAt.get(flushKey) ?? 0;
      const force = this.forceDbFlush.delete(flushKey);
      if (force || now - last >= DB_SAVE_INTERVAL_MS) {
        this.lastDbFlushAt.set(flushKey, now);
        await supabase.from('source_state').upsert(
          { user_id: userId, source_id: sourceId, payload: next, updated_at: new Date().toISOString() },
          { onConflict: 'user_id,source_id' },
        );
      }
    };
    return { supabase, userId, payload, savePayload };
  }

  async stop() {
    this.stopping = true;
    if (this.discoverTimer) clearInterval(this.discoverTimer);
    for (const sched of this.scheduled.values()) clearInterval(sched.timer);
    // Mark every live (userId, sourceId) for a forced DB flush on its
    // next savePayload. The worker's in-flight tick (if any) will carry
    // state of the world to DB; if no tick is pending we ignore — the
    // runtime cache still has the latest copy, so a restart within TTL
    // recovers cleanly without needing the DB write at all.
    for (const [key, sched] of this.scheduled) {
      void sched;
      this.forceDbFlush.add(key);
    }
    this.scheduled.clear();
    console.log('b1dzd: stopped');
  }
}
