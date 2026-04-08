/**
 * DealDash credentials — per-user, stored in source_state in Supabase.
 *
 * Why not .env: each user of b1dz needs their own DealDash session, so a
 * single shared environment variable doesn't fly. We persist a parsed
 * `{ phpsessid, rememberme }` blob in source_state.payload.credentials and
 * rebuild the Cookie header at runtime.
 *
 * Storage shape:
 *   source_state.payload = {
 *     credentials: { phpsessid: '...', rememberme: '...', savedAt: '...' }
 *   }
 *
 * Reads/writes go through the secret key (RLS bypass) but stamp `user_id`
 * so RLS attribution stays correct when the dashboard reads.
 */

import { getApiClient } from '../auth.js';

export interface DealDashCreds { phpsessid: string; rememberme: string; savedAt: string; }

/**
 * Parse a raw cookie string (or pasted cURL header) and extract the two
 * cookies we care about. Tolerant of different formats:
 *   - "PHPSESSID=...; REMEMBERME=..."
 *   - "Cookie: PHPSESSID=...; REMEMBERME=..."
 *   - browser DevTools "Request Cookies" JSON object
 *   - JSON with quotes around values
 */
export function parseDealDashCookie(raw: string): DealDashCreds | null {
  const tryMatch = (re: RegExp) => raw.match(re)?.[1];
  const phpsessid = tryMatch(/PHPSESSID["']?\s*[:=]\s*["']?([A-Za-z0-9_%-]+)/);
  const rememberme = tryMatch(/REMEMBERME["']?\s*[:=]\s*["']?([A-Za-z0-9._%~:!+-]+)/);
  if (!phpsessid || !rememberme) return null;
  return { phpsessid, rememberme, savedAt: new Date().toISOString() };
}

/** Build the Cookie header value the dealdash API client expects. */
export function buildCookieHeader(c: DealDashCreds): string {
  return `PHPSESSID=${c.phpsessid}; REMEMBERME=${c.rememberme}`;
}

const makeApi = getApiClient;

export async function loadDealDashCreds(_userId: string): Promise<DealDashCreds | null> {
  const api = makeApi();
  const payload = await api.get<{ credentials?: DealDashCreds }>('source-state', 'dealdash');
  return payload?.credentials ?? null;
}

export async function saveDealDashCreds(_userId: string, creds: DealDashCreds): Promise<void> {
  const api = makeApi();
  const existing = (await api.get<Record<string, unknown>>('source-state', 'dealdash')) ?? {};
  const payload = { ...existing, credentials: creds, sourceId: 'dealdash' };
  await api.put('source-state', 'dealdash', payload);
}
