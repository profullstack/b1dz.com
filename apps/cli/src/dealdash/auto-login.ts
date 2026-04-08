/**
 * Automated DealDash login via browserless + capsolver.
 *
 * Flow:
 *   1. connect to browserless (real Chromium, optional proxy)
 *   2. open dealdash login page
 *   3. fill email + password
 *   4. if reCAPTCHA appears: extract sitekey → capsolver → inject token
 *   5. submit, wait for navigation
 *   6. read PHPSESSID + REMEMBERME cookies → save via existing creds helper
 *
 * Important: this is a TOS gray area. Use it only on your own account at
 * reasonable cadence. Sessions last ~30 days; you should not need to run
 * this more than once per month per account.
 *
 * The exact form selectors and login URL may need tweaking the first time
 * you run it — DealDash's markup is whatever the user finds when they
 * inspect the live page. Constants are clearly marked below for easy
 * adjustment.
 */

import puppeteer, { type Browser } from 'puppeteer';
import { saveDealDashCreds } from './credentials.js';
import { solveRecaptchaV2 } from './capsolver.js';

// ---------- Tunables — adjust if DealDash changes their markup ----------
const LOGIN_URL = 'https://www.dealdash.com/login';
// DealDash uses generated React class names that change between releases.
// We try a stable fallback first (input[type=email/password]) and only use
// the brittle generated selectors as a last resort.
const EMAIL_SELECTOR = [
  'input[type="email"]',
  'div.r-1cmwbt1:nth-child(1) > div:nth-child(3) > input:nth-child(1)',
].join(', ');
const PASSWORD_SELECTOR = [
  'input[type="password"]',
  'form.css-g5y9jx > div:nth-child(2) > div:nth-child(3) > input:nth-child(1)',
].join(', ');
const SUBMIT_SELECTOR = [
  'button[aria-label="Log In"]',
  'button[type="submit"]',
].join(', ');
const RECAPTCHA_SITEKEY_ATTR = 'data-sitekey';
// -----------------------------------------------------------------------

async function connectBrowser(): Promise<Browser> {
  // Local Chromium via puppeteer (auto-downloaded on install). Honors the
  // HEADLESS env var so you can watch the login flow with HEADLESS=false.
  const headless = process.env.HEADLESS !== 'false';
  return puppeteer.launch({
    headless,
    defaultViewport: { width: 1366, height: 768 },
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
    ],
  });
}

export async function autoLoginDealDash(opts: { userId: string; email: string; password: string }): Promise<void> {
  const browser = await connectBrowser();
  try {
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36');

    console.log(`→ navigating to ${LOGIN_URL}`);
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });

    await page.waitForSelector(EMAIL_SELECTOR, { timeout: 30_000 });
    await page.type(EMAIL_SELECTOR, opts.email, { delay: 30 });
    await page.type(PASSWORD_SELECTOR, opts.password, { delay: 30 });

    // Detect captcha — try multiple strategies because DealDash could use
    // reCAPTCHA v2/v3, hCaptcha, or Cloudflare Turnstile, and the sitekey
    // can live on the parent page OR in an iframe src query string.
    await new Promise((r) => setTimeout(r, 1500)); // give the captcha widget a beat to mount

    let sitekey: string | null = null;
    let captchaKind: 'recaptcha' | 'hcaptcha' | 'turnstile' | null = null;

    // 1. Check the parent page DOM
    sitekey = await page.evaluate(() => {
      const el = document.querySelector('[data-sitekey]') as HTMLElement | null;
      return el?.getAttribute('data-sitekey') ?? null;
    });
    if (sitekey) captchaKind = 'recaptcha';

    // 2. Walk every iframe and look at the src URL for ?k=<sitekey>
    if (!sitekey) {
      for (const frame of page.frames()) {
        const url = frame.url();
        const m = url.match(/\b(recaptcha|hcaptcha|turnstile)\b/i);
        if (!m) continue;
        const km = url.match(/[?&]k=([^&]+)/) || url.match(/[?&]sitekey=([^&]+)/);
        if (km) {
          sitekey = decodeURIComponent(km[1]);
          captchaKind = m[1].toLowerCase().includes('hcaptcha') ? 'hcaptcha'
            : m[1].toLowerCase().includes('turnstile') ? 'turnstile'
            : 'recaptcha';
          break;
        }
      }
    }

    // 3. Last resort: dig into ___grecaptcha_cfg
    if (!sitekey) {
      sitekey = await page.evaluate(() => {
        const cfg = (window as unknown as { ___grecaptcha_cfg?: { clients?: Record<string, unknown> } }).___grecaptcha_cfg;
        if (!cfg?.clients) return null;
        for (const c of Object.values(cfg.clients)) {
          const stack: unknown[] = [c];
          while (stack.length) {
            const cur = stack.pop() as Record<string, unknown> | undefined;
            if (cur && typeof cur === 'object') {
              for (const v of Object.values(cur)) {
                if (typeof v === 'string' && v.length === 40) return v;
                if (v && typeof v === 'object') stack.push(v);
              }
            }
          }
        }
        return null;
      });
      if (sitekey) captchaKind = 'recaptcha';
    }

    console.log(`→ captcha scan: kind=${captchaKind ?? 'none'} sitekey=${sitekey ? sitekey.slice(0, 12) + '…' : 'none'}`);

    if (sitekey) {
      console.log(`→ captcha detected (sitekey ${sitekey.slice(0, 12)}…), solving via capsolver`);
      const token = await solveRecaptchaV2({ siteKey: sitekey, pageUrl: LOGIN_URL });
      console.log('→ injecting captcha token…');
      await page.evaluate((t) => {
        // Set every g-recaptcha-response textarea on the page (there can be more than one)
        for (const ta of Array.from(document.querySelectorAll('textarea#g-recaptcha-response, textarea[name="g-recaptcha-response"]'))) {
          (ta as HTMLTextAreaElement).style.display = 'block';
          (ta as HTMLTextAreaElement).value = t;
        }
        // Try to find and fire the reCAPTCHA callback. Bounded walk with a
        // visited set so we can't infinite-loop on cyclic objects.
        const cfg = (window as unknown as { ___grecaptcha_cfg?: { clients?: Record<string, unknown> } }).___grecaptcha_cfg;
        if (!cfg?.clients) return;
        const seen = new WeakSet<object>();
        let calls = 0;
        const MAX_CALLS = 8;
        const MAX_NODES = 5000;
        let nodes = 0;
        const stack: unknown[] = Object.values(cfg.clients);
        while (stack.length && nodes < MAX_NODES && calls < MAX_CALLS) {
          const cur = stack.pop();
          nodes++;
          if (!cur || typeof cur !== 'object') continue;
          if (seen.has(cur as object)) continue;
          seen.add(cur as object);
          for (const v of Object.values(cur as Record<string, unknown>)) {
            if (typeof v === 'function') {
              try { (v as (s: string) => void)(t); calls++; if (calls >= MAX_CALLS) break; } catch {}
            } else if (v && typeof v === 'object') {
              stack.push(v);
            }
          }
        }
      }, token);
      console.log('→ captcha token injected');
    }

    // Log every network response so we can see what fires after submit
    page.on('response', (res) => {
      const url = res.url();
      if (/dealdash\.com/.test(url) && (url.includes('login') || url.includes('auth') || url.includes('user'))) {
        console.log(`  ← ${res.status()} ${url}`);
      }
    });

    console.log('→ submitting login form');
    const submitFound = await page.$(SUBMIT_SELECTOR);
    if (!submitFound) {
      try { await page.screenshot({ path: '/tmp/b1dz-login-fail.png', fullPage: true }); } catch {}
      throw new Error(`submit button not found (${SUBMIT_SELECTOR}) — screenshot /tmp/b1dz-login-fail.png`);
    }
    await submitFound.click();
    console.log('→ click fired, polling cookies…');

    // DealDash is a React SPA — no full navigation happens after login,
    // just an XHR + client-side route change. Poll for the REMEMBERME
    // cookie via page.cookies() (more reliable than browser.cookies()
    // over browserless).
    let phpsessid: string | undefined;
    let rememberme: string | undefined;
    const deadline = Date.now() + 60_000;
    let lastLog = 0;
    while (Date.now() < deadline) {
      const cookies = await page.cookies('https://www.dealdash.com');
      const get = (name: string) => cookies.find((c) => c.name === name)?.value;
      phpsessid = get('PHPSESSID');
      rememberme = get('REMEMBERME');
      if (rememberme) break;
      // Heartbeat every 5s
      if (Date.now() - lastLog > 5000) {
        lastLog = Date.now();
        const url = page.url();
        const cookieNames = cookies.map((c) => c.name).join(',') || '(none)';
        console.log(`  ⏳ url=${url}  cookies=${cookieNames}`);
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (!phpsessid || !rememberme) {
      try { await page.screenshot({ path: '/tmp/b1dz-login-fail.png', fullPage: true }); } catch {}
      throw new Error('login appeared to fail — REMEMBERME not set after 60s. Screenshot at /tmp/b1dz-login-fail.png');
    }

    await saveDealDashCreds(opts.userId, {
      phpsessid,
      rememberme,
      savedAt: new Date().toISOString(),
    });
    console.log('✓ DealDash session saved.');
  } finally {
    await browser.close();
  }
}
