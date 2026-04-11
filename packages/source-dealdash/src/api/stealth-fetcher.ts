/**
 * Stealth fetcher — uses got-scraping to impersonate Chrome's TLS
 * fingerprint (JA3/JA4) from pure Node.js. No browser, no display,
 * no xvfb. Cloudflare sees a real Chrome-like TLS handshake.
 *
 * Drop-in replacement for makeDealDashFetcher(). Same DealDashFetcher
 * interface.
 */

import type { DealDashFetcher, DealDashCreds } from './fetcher.js';
import { buildCookie } from './fetcher.js';

const DEFAULT_HEADERS: Record<string, string> = {
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'X-Client-Platform': 'desktop-web',
  'X-Client-Build-Version': '7.6.4 / 24083310927',
  'X-Client-Whitelabel': 'dealdash',
};

export function makeStealthFetcher(creds: DealDashCreds, baseUrl = 'https://www.dealdash.com'): DealDashFetcher {
  const cookie = buildCookie(creds);

  return async (path, init = {}) => {
    const { gotScraping } = await import('got-scraping');
    const url = path.startsWith('http') ? path : `${baseUrl}${path}`;
    const method = (init.method ?? 'GET').toUpperCase();
    const headers = {
      ...DEFAULT_HEADERS,
      Cookie: cookie,
      ...(init.headers as Record<string, string> || {}),
    };

    const res = await gotScraping({
      url,
      method: method as 'GET' | 'POST' | 'PUT' | 'DELETE',
      headers,
      body: init.body as string | undefined,
      // Use Chrome fingerprint
      useHeaderGenerator: false,
      // Don't follow redirects automatically — we want to see 3xx
      followRedirect: false,
      // Reasonable timeout
      timeout: { request: 30_000 },
      // Don't throw on non-2xx
      throwHttpErrors: false,
    });

    return new Response(res.body, {
      status: res.statusCode,
      statusText: res.statusMessage,
    });
  };
}
