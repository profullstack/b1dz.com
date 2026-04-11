/**
 * Browser-based DealDashFetcher — routes all HTTP calls through a
 * persistent headless Chrome session so Cloudflare's TLS fingerprinting
 * and JS challenges pass transparently.
 *
 * Drop-in replacement for makeDealDashFetcher(). Same interface, different
 * transport. The daemon / TUI calls `createBrowserFetcher(creds)` once at
 * startup; the returned fetcher keeps the browser alive across ticks.
 * Call `close()` on shutdown.
 */

import type { DealDashFetcher, DealDashCreds } from './fetcher.js';
import { buildCookie } from './fetcher.js';

export interface BrowserFetcherHandle {
  fetch: DealDashFetcher;
  close: () => Promise<void>;
}

export async function createBrowserFetcher(
  creds: DealDashCreds,
  opts?: { headless?: boolean; baseUrl?: string },
): Promise<BrowserFetcherHandle> {
  // puppeteer-extra + stealth plugin patches all the automation detection
  // vectors Cloudflare checks (navigator.webdriver, chrome.runtime,
  // plugins array, WebGL renderer, etc.)
  const puppeteerExtra = await import('puppeteer-extra');
  const StealthPlugin = await import('puppeteer-extra-plugin-stealth');
  puppeteerExtra.default.use(StealthPlugin.default());

  // Force headed mode — Cloudflare's managed challenge detects headless
  // Chrome even with the stealth plugin. On a headless server, run under
  // xvfb: `xvfb-run --auto-servernum b1dz dealdash tui`
  const baseUrl = opts?.baseUrl ?? 'https://www.dealdash.com';

  // Proxy support — route through a residential proxy so requests
  // come from a clean IP (server IP may be flagged by Cloudflare).
  const proxyUrl = process.env.PROXY_URL;
  const proxyUser = process.env.PROXY_USERNAME;
  const proxyPass = process.env.PROXY_PASSWORD;
  const useProxy = process.env.ENABLE_PROXY === 'true' && proxyUrl;

  const browser = await puppeteerExtra.default.launch({
    headless: false,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--window-size=1366,768',
      ...(useProxy ? [`--proxy-server=${proxyUrl}`] : []),
    ],
    defaultViewport: { width: 1366, height: 768 },
  });

  const page = await browser.newPage();

  // Authenticate with the proxy if credentials are provided
  if (useProxy && proxyUser && proxyPass) {
    await page.authenticate({ username: proxyUser, password: proxyPass });
    console.log(`browser-fetcher: using proxy ${proxyUrl}`);
  }

  await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36');

  // Set cookies before any navigation so Cloudflare sees them immediately
  const cookieDomain = '.dealdash.com';
  await page.setCookie(
    { name: 'PHPSESSID', value: creds.phpsessid, domain: cookieDomain, path: '/' },
    { name: 'REMEMBERME', value: creds.rememberme, domain: cookieDomain, path: '/' },
    ...(creds.cfClearance ? [{ name: 'cf_clearance', value: creds.cfClearance, domain: cookieDomain, path: '/' }] : []),
  );

  // Navigate to the base URL and wait for Cloudflare's JS challenge to
  // complete. The challenge page title is "Just a moment..." — we poll
  // until the title changes (meaning the real DealDash page has loaded)
  // or we time out after 60 seconds.
  console.log('browser-fetcher: warming up Cloudflare session…');
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const title = await page.title();
    if (!title.toLowerCase().includes('just a moment') && !title.toLowerCase().includes('attention required')) {
      console.log(`browser-fetcher: Cloudflare cleared (title: "${title}")`);
      break;
    }
    await new Promise(r => setTimeout(r, 2000));
    console.log('browser-fetcher: waiting for Cloudflare challenge to clear…');
  }
  const finalTitle = await page.title();
  if (finalTitle.toLowerCase().includes('just a moment')) {
    console.error('browser-fetcher: WARNING — Cloudflare challenge did NOT clear after 60s. Requests will likely fail.');
  }
  console.log(`browser-fetcher: ready (url: ${page.url()}, title: "${finalTitle}")`);

  const fetchViaPage: DealDashFetcher = async (path, init = {}) => {
    const url = path.startsWith('http') ? path : `${baseUrl}${path}`;
    const method = init.method ?? 'GET';
    const headers = init.headers ?? {};
    const body = init.body ?? null;

    // Execute fetch INSIDE the browser context so Cloudflare sees the
    // real Chrome TLS fingerprint + JS environment.
    const result = await page.evaluate(
      async (fetchUrl: string, fetchMethod: string, fetchHeaders: Record<string, string>, fetchBody: string | null) => {
        const res = await fetch(fetchUrl, {
          method: fetchMethod,
          headers: { 'Content-Type': 'application/json', ...fetchHeaders },
          body: fetchBody,
          credentials: 'include',
        });
        const text = await res.text();
        return { status: res.status, statusText: res.statusText, body: text };
      },
      url,
      method,
      headers as Record<string, string>,
      typeof body === 'string' ? body : null,
    );

    // Log first response so we can see if Cloudflare is still blocking
    if (result.body.includes('Just a moment') || result.body.includes('challenge-platform')) {
      console.log(`browser-fetcher: Cloudflare challenge on ${url.slice(0, 80)}`);
    }
    return new Response(result.body, {
      status: result.status,
      statusText: result.statusText,
    });
  };

  return {
    fetch: fetchViaPage,
    close: async () => { await browser.close(); },
  };
}
