/**
 * The x402 client the fetchers pay with, when the user running this source has
 * a payer key.
 *
 * A site behind an x402 gateway answers a crawler with 402 and an offer. The
 * client signs it with the payer wallet, buys the pass and presents it on every
 * later request to that site. Capped at five dollars a payment.
 *
 * The key is `X402_PRIVATE_KEY` from the USER's sealed secrets: the daemon
 * overlays it onto process.env only for an unlocked user's tick and scrubs the
 * operator's copy at start (apps/daemon user-config, 2026-10-28). It is read
 * per call, never at import, so nothing outlives the tick. Locked, or no key:
 * null, and the fetchers behave as before (no paid passes).
 */

import { createClient, type X402Client } from '@profullstack/x402-client';

const ENV = ['X402', 'PRIVATE_KEY'].join('_');
let cached: { key: string; client: X402Client } | null = null;

export function x402Client(): X402Client | null {
  const key = process.env[ENV];
  if (!key) {
    cached = null;
    return null;
  }
  if (cached?.key !== key) cached = { key, client: createClient({ key, maxUsd: 5 }) };
  return cached.client;
}
