/**
 * The x402 client the fetchers pay with, when a key is configured.
 *
 * A site behind an x402 gateway answers a crawler with 402 and an offer. With
 * `X402_PRIVATE_KEY` set, the client signs the offer with the shared crawler
 * wallet, buys the pass and presents it on every later request to that site.
 * Without the key it is null and the fetchers behave as before. Capped at
 * five dollars a payment.
 */

import { createClient, type X402Client } from '@profullstack/x402-client';

const key = process.env[['X402', 'PRIVATE_KEY'].join('_')];

export const x402: X402Client | null = key ? createClient({ key, maxUsd: 5 }) : null;
