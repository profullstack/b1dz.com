/**
 * Request throttle — limits the rate of outbound DealDash requests to
 * avoid triggering abuse detection / bans. Wraps a DealDashFetcher.
 *
 * Default: max 1 request per 500ms (2/sec). DealDash's normal UI makes
 * ~1 req/sec at most; we want to stay well under that.
 *
 * configurable via DEALDASH_THROTTLE_MS env (milliseconds between requests).
 */

import type { DealDashFetcher } from './fetcher.js';

export function withThrottle(
  fetcher: DealDashFetcher,
  minIntervalMs = Number(process.env.DEALDASH_THROTTLE_MS || '500'),
): DealDashFetcher {
  let lastRequestAt = 0;

  return async (path: string, init?: RequestInit): Promise<Response> => {
    const now = Date.now();
    const elapsed = now - lastRequestAt;
    if (elapsed < minIntervalMs) {
      await new Promise(r => setTimeout(r, minIntervalMs - elapsed));
    }
    lastRequestAt = Date.now();
    return fetcher(path, init);
  };
}
