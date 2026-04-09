/**
 * DealDashFetcher — the seam every API call goes through.
 *
 * Inject this into all the lifted polling functions instead of hard-coding
 * `fetch()` + global cookies. That gives us:
 *   - per-user sessions: each user gets their own fetcher
 *   - testability: tests inject a stub fetcher with canned responses
 *   - server safety: the API server can host the cookies, the daemon
 *     reads them out of source_state, the CLI never sees them
 */

export interface DealDashCreds {
  phpsessid: string;
  rememberme: string;
}

export interface DealDashFetcher {
  (path: string, init?: RequestInit): Promise<Response>;
}

const DEFAULT_HEADERS: Record<string, string> = {
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'X-Client-Platform': 'desktop-web',
  'X-Client-Build-Version': '7.6.4 / 24083310927',
  'X-Client-Whitelabel': 'dealdash',
};

export function buildCookie(c: DealDashCreds): string {
  return `PHPSESSID=${c.phpsessid}; REMEMBERME=${c.rememberme}`;
}

/** Construct a fetcher that automatically appends DealDash cookies + UA. */
export function makeDealDashFetcher(creds: DealDashCreds, baseUrl = 'https://www.dealdash.com'): DealDashFetcher {
  const cookie = buildCookie(creds);
  return async (path, init = {}) => {
    const url = path.startsWith('http') ? path : `${baseUrl}${path}`;
    return fetch(url, {
      ...init,
      headers: {
        ...DEFAULT_HEADERS,
        Cookie: cookie,
        ...(init.headers || {}),
      },
    });
  };
}

/** Stub fetcher for tests — given a router, return canned responses. */
export function stubFetcher(router: (path: string, init: RequestInit) => Response | Promise<Response>): DealDashFetcher {
  return (path, init = {}) => Promise.resolve(router(path, init));
}
