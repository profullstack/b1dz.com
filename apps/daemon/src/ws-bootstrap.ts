/**
 * Daemon-wide WebSocket bootstrap.
 *
 * Owns the lifecycle of the shared @b1dz/source-crypto-arb price-cache
 * subscriptions at process scope, independent of any individual source
 * worker. Previously WS init was buried inside cryptoArbWorker.tick(),
 * which meant:
 *
 *   1. Users with crypto-trade enabled but not crypto-arb got ZERO
 *      websocket pricing — every snapshot fell back to REST every 5s
 *      and the daemon looked "stale" because each tick took longer
 *      than the next polling cadence.
 *   2. Pairs added by other workers (DCA, dynamic discovery, the v2
 *      observer) never got subscribed because the wsInitialized gate
 *      ran exactly once per process lifetime.
 *
 * This module exposes start()/stop() called from DaemonRuntime, plus a
 * periodic refresh that re-runs pair discovery and adds anything new.
 *
 * It deliberately does NOT release pairs — over the daemon's lifetime
 * we want a stable baseline subscription that workers can rely on. The
 * release path is for ephemeral consumers (the TUI's chart, the web
 * dashboard's chart) that come and go.
 */

import { setWsLogger, subscribeWs, getActivePairs, wsHealthSnapshot } from '@b1dz/source-crypto-arb';

/** Default fallback pairs when discovery returns empty (cold start, API
 *  outages, etc.). Conservative top-three majors so a fresh daemon
 *  always has SOMETHING streaming for the dashboard. */
const FALLBACK_PAIRS = ['BTC-USD', 'ETH-USD', 'SOL-USD'];

/** Re-run pair discovery this often. Same cadence as discoverIntervalMs
 *  in DaemonRuntime — fresh users → fresh pairs → fresh subscriptions. */
const REFRESH_INTERVAL_MS = 60_000;

/** Log a one-line health summary this often. Helps identify silent
 *  stalls in production logs without needing a debug endpoint. */
const HEALTH_LOG_INTERVAL_MS = 60_000;

let started = false;
let refreshTimer: ReturnType<typeof setInterval> | null = null;
let healthTimer: ReturnType<typeof setInterval> | null = null;

async function refreshPairs(): Promise<void> {
  try {
    const discovered = await getActivePairs();
    const next = discovered.length > 0 ? discovered : FALLBACK_PAIRS;
    subscribeWs(next);
  } catch (e) {
    console.error(`[ws-bootstrap] refresh failed: ${(e as Error).message}`);
  }
}

export async function startWsBootstrap(): Promise<void> {
  if (started) return;
  started = true;

  // Route ws-cache logs through the daemon's stdout so Railway/journalctl
  // pick them up. The crypto-arb worker also installs a logger when it
  // ticks — last writer wins, both end up in the same stream.
  setWsLogger((msg) => console.log(msg));

  // Subscribe to fallback pairs immediately so the dashboard has data
  // within ~2 seconds of daemon boot, even if pair discovery is slow.
  subscribeWs(FALLBACK_PAIRS);
  console.log(`[ws-bootstrap] subscribed to ${FALLBACK_PAIRS.length} fallback pairs while discovery runs`);

  // Then layer on the discovered set as soon as it's available.
  await refreshPairs();

  refreshTimer = setInterval(() => { void refreshPairs(); }, REFRESH_INTERVAL_MS);
  // .unref so the timer doesn't keep the process alive on shutdown.
  refreshTimer.unref?.();

  healthTimer = setInterval(() => {
    const snap = wsHealthSnapshot();
    const geminiUp = snap.gemini.filter((g: { connected: boolean }) => g.connected).length;
    console.log(
      `[ws-health] pairs=${snap.subscribedPairCount} cached=${snap.cacheSize} `
      + `kraken=${snap.kraken.connected ? 'up' : 'DOWN'}(${snap.kraken.ageMs}ms) `
      + `coinbase=${snap.coinbase.connected ? 'up' : 'DOWN'}(${snap.coinbase.ageMs}ms) `
      + `binanceUs=${snap.binanceUs.connected ? 'up' : 'DOWN'}(${snap.binanceUs.ageMs}ms) `
      + `gemini=${geminiUp}/${snap.gemini.length}`,
    );
  }, HEALTH_LOG_INTERVAL_MS);
  healthTimer.unref?.();
}

export function stopWsBootstrap(): void {
  if (!started) return;
  started = false;
  if (refreshTimer) clearInterval(refreshTimer);
  if (healthTimer) clearInterval(healthTimer);
  refreshTimer = null;
  healthTimer = null;
  // We deliberately do NOT release the subscriptions on stop — process
  // exit tears down sockets anyway, and explicit release here would
  // race with shutdown ticks that may still want to read the cache.
}
