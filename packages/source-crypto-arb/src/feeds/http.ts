/**
 * Shared fetch wrapper with retry, backoff, per-host rate limiting,
 * and proxy support for blocked hosts (e.g. Binance.US).
 */

import { proxyFetch } from './proxy.js';

const MIN_INTERVAL_MS = 100; // batch calls = fewer requests, can throttle less
const lastRequestAt = new Map<string, number>();

// Reserve the next slot per host before waiting, so concurrent callers
// queue at MIN_INTERVAL_MS apart instead of all reading the same "last"
// timestamp and firing together.
async function throttle(host: string): Promise<void> {
  const slot = Math.max(Date.now(), lastRequestAt.get(host) ?? 0);
  lastRequestAt.set(host, slot + MIN_INTERVAL_MS);
  const wait = slot - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

export async function fetchJson<T>(url: string, retries = 3): Promise<T> {
  const host = new URL(url).host;
  let lastErr: Error | undefined;

  for (let attempt = 0; attempt < retries; attempt++) {
    await throttle(host);
    try {
      const res = await proxyFetch(url);
      if (res.ok) return (await res.json()) as T;
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`${res.status} ${res.statusText}`);
        const delay = Math.min(1000 * 2 ** attempt, 8000) + Math.random() * 500;
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw new Error(`${url}: ${res.status} ${res.statusText}`);
    } catch (e) {
      lastErr = e as Error;
      if (attempt < retries - 1) {
        const delay = Math.min(1000 * 2 ** attempt, 8000);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastErr ?? new Error(`fetchJson failed: ${url}`);
}
