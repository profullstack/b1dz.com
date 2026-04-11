/**
 * Server-side DealDash helper. Loads the authenticated user's cookies from
 * `source_state.payload.credentials` and returns a fetch function that auto
 * adds the right headers. This is the only place in the codebase that reads
 * the user's DealDash session — every API route uses this, no client code
 * ever sees the cookies.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

export interface DealDashCreds { phpsessid: string; rememberme: string; cfClearance?: string; }

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'X-Client-Platform': 'desktop-web',
  'X-Client-Build-Version': '7.6.4 / 24083310927',
  'X-Client-Whitelabel': 'dealdash',
};

export async function loadCreds(client: SupabaseClient): Promise<DealDashCreds | null> {
  const { data } = await client.from('source_state').select('payload').eq('source_id', 'dealdash').maybeSingle();
  if (!data) return null;
  const c = (data.payload as { credentials?: DealDashCreds })?.credentials;
  return c ?? null;
}

export function buildCookie(c: DealDashCreds): string {
  let cookie = `PHPSESSID=${c.phpsessid}; REMEMBERME=${c.rememberme}`;
  if (c.cfClearance) cookie += `; cf_clearance=${c.cfClearance}`;
  return cookie;
}

export interface DealDashFetch {
  (path: string, init?: RequestInit): Promise<Response>;
}

export async function dealDashFetcher(client: SupabaseClient): Promise<DealDashFetch | null> {
  const c = await loadCreds(client);
  if (!c) return null;
  const cookie = buildCookie(c);
  return async (path: string, init: RequestInit = {}) => {
    const url = path.startsWith('http') ? path : `https://www.dealdash.com${path}`;
    return fetch(url, {
      ...init,
      headers: {
        ...HEADERS,
        Cookie: cookie,
        ...(init.headers || {}),
      },
    });
  };
}
