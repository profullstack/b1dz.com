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

import { createClient } from '@supabase/supabase-js';

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

function adminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) throw new Error('Supabase admin env not set in .env');
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

export async function loadDealDashCreds(userId: string): Promise<DealDashCreds | null> {
  const client = adminClient();
  const { data, error } = await client
    .from('source_state')
    .select('payload')
    .eq('user_id', userId)
    .eq('source_id', 'dealdash')
    .maybeSingle();
  if (error || !data) return null;
  const creds = (data.payload as { credentials?: DealDashCreds })?.credentials;
  return creds ?? null;
}

export async function saveDealDashCreds(userId: string, creds: DealDashCreds): Promise<void> {
  const client = adminClient();
  // Read existing payload so we don't clobber other source_state fields
  const { data: existing } = await client
    .from('source_state')
    .select('payload')
    .eq('user_id', userId)
    .eq('source_id', 'dealdash')
    .maybeSingle();
  const payload = { ...(existing?.payload ?? {}), credentials: creds };
  const { error } = await client.from('source_state').upsert(
    { user_id: userId, source_id: 'dealdash', payload, updated_at: new Date().toISOString() },
    { onConflict: 'user_id,source_id' },
  );
  if (error) throw error;
}
