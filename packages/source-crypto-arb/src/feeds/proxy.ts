/**
 * Proxy-aware fetch for hosts that block datacenter IPs (e.g. Binance.US).
 *
 * Uses Node's built-in undici ProxyAgent (not the npm package) so it's
 * compatible with the built-in fetch().
 */

const PROXIED_HOSTS = ['api.binance.us'];

let cachedProxyUrl: string | null | undefined;

function getProxyUrl(): string | null {
  if (cachedProxyUrl !== undefined) return cachedProxyUrl;
  if (process.env.ENABLE_PROXY !== 'true') {
    cachedProxyUrl = null;
    return null;
  }
  const url = process.env.PROXY_URL;
  const user = process.env.PROXY_USERNAME;
  const pass = process.env.PROXY_PASSWORD;
  if (!url) { cachedProxyUrl = null; return null; }

  cachedProxyUrl = user && pass
    ? url.replace('://', `://${user}:${pass}@`)
    : url;
  return cachedProxyUrl;
}

export function shouldProxy(url: string): boolean {
  const host = new URL(url).host;
  return PROXIED_HOSTS.includes(host);
}

/**
 * Fetch with proxy support. Uses child_process curl for proxied requests
 * since Node's built-in fetch + undici ProxyAgent have version conflicts.
 */
export async function proxyFetch(url: string, init?: RequestInit): Promise<Response> {
  if (!shouldProxy(url)) return fetch(url, init);

  const proxyUrl = getProxyUrl();
  if (!proxyUrl) return fetch(url, init);

  // Use curl through proxy — most reliable approach
  const { execFileSync } = await import('node:child_process');
  const method = init?.method ?? 'GET';
  const headers = init?.headers as Record<string, string> | undefined;
  const args = ['-sS', '--fail-with-body', '-x', proxyUrl, '--max-time', '15', '-X', method];
  if (headers) {
    for (const [k, v] of Object.entries(headers)) {
      args.push('-H', `${k}: ${v}`);
    }
  }
  if (init?.body) {
    args.push('-d', String(init.body));
  }
  args.push(url);

  try {
    const stdout = execFileSync('curl', args, { encoding: 'utf8', timeout: 20000 });
    return new Response(stdout, { status: 200, headers: { 'content-type': 'application/json' } });
  } catch (e) {
    const host = new URL(url).host;
    const err = e as Error & { stderr?: string | Buffer };
    const stderr = typeof err.stderr === 'string'
      ? err.stderr.trim()
      : Buffer.isBuffer(err.stderr)
        ? err.stderr.toString('utf8').trim()
        : '';
    const detail = stderr || err.message || 'unknown proxy error';
    console.error(`[proxy] ✗ ${host} failed: ${detail.slice(0, 300)}`);
    return new Response(JSON.stringify({ error: `proxy fetch failed for ${host}` }), { status: 502, headers: { 'content-type': 'application/json' } });
  }
}
