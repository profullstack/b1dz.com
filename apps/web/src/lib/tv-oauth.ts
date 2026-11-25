/**
 * Live TV in the terminal: connect a visitor's hdtilt.com account (OAuth 2.1,
 * public client `b1dz-web`, PKCE) so the page can play their own channels.
 *
 *   GET  /api/tv/start       begin: PKCE + state cookies, redirect to hdtilt's consent page
 *   GET  /api/tv/callback    hdtilt returns ?code&state; exchange it, keep the tokens in cookies
 *   GET  /api/tv/token       { connected, accessToken, expiresAt, site } for the player
 *   POST /api/tv/disconnect  revoke at hdtilt and forget the tokens
 *
 * Nothing is stored on this server. The refresh token lives in an httpOnly
 * cookie scoped to /api/tv (page script cannot read it); the page only ever
 * receives the one-hour access token, which it sends straight to hdtilt.com
 * as a bearer header on stream requests. b1dz never relays video and never
 * sees a playlist address: channels are found by name with hdtilt's
 * /api/tv/find.
 *
 * hdtilt rotates the refresh token on every use and revokes the whole family
 * when an old one is replayed, so the access token is cached in its own cookie
 * and refreshed only when it is about to expire.
 */
import { createHash, randomBytes } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { requestOrigin } from '@/lib/credits';

export const TV_CLIENT_ID = 'b1dz-web';
const RT = 'tv_rt';
const AT = 'tv_at';
const AT_EXP = 'tv_at_exp';
const STATE = 'tv_state';
const PKCE = 'tv_pkce';
const PATH = '/api/tv';
/** hdtilt refresh tokens last 90 days. */
const RT_MAX_AGE = 90 * 86_400;
/** Hand out a cached access token only while it has this long left. */
const MIN_LEFT_MS = 5 * 60_000;

export function tvSite(): string {
  return (process.env.HDTILT_URL || 'https://hdtilt.com').replace(/\/+$/, '');
}

const noStore = { 'cache-control': 'no-store' };

function cookieOpts(req: NextRequest, maxAge: number) {
  return { httpOnly: true, secure: requestOrigin(req).startsWith('https'), sameSite: 'lax' as const, path: PATH, maxAge };
}

interface Tokens {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

async function tokenCall(params: Record<string, string>, fetchImpl: typeof fetch = fetch): Promise<{ ok: boolean; status: number; body: Tokens }> {
  try {
    const res = await fetchImpl(`${tvSite()}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', 'user-agent': 'b1dz-terminal-tv/1' },
      body: new URLSearchParams({ ...params, client_id: TV_CLIENT_ID }).toString(),
      cache: 'no-store',
      signal: AbortSignal.timeout(15_000),
    });
    return { ok: res.ok, status: res.status, body: (await res.json().catch(() => ({}))) as Tokens };
  } catch {
    return { ok: false, status: 0, body: { error: 'unreachable' } };
  }
}

function setTokens(req: NextRequest, res: NextResponse, t: Tokens, now = Date.now()): number {
  const expiresAt = now + Math.max(60, Number(t.expires_in) || 3600) * 1000;
  if (t.refresh_token) res.cookies.set(RT, t.refresh_token, cookieOpts(req, RT_MAX_AGE));
  res.cookies.set(AT, t.access_token!, cookieOpts(req, Math.floor((expiresAt - now) / 1000)));
  res.cookies.set(AT_EXP, String(expiresAt), cookieOpts(req, Math.floor((expiresAt - now) / 1000)));
  return expiresAt;
}

function clearTokens(res: NextResponse): void {
  for (const name of [RT, AT, AT_EXP]) res.cookies.set(name, '', { path: PATH, maxAge: 0 });
}

/** GET /api/tv/start */
export function tvStart(req: NextRequest): NextResponse {
  const origin = requestOrigin(req);
  const verifier = randomBytes(48).toString('base64url');
  const state = randomBytes(24).toString('base64url');
  const authorize = new URL(`${tvSite()}/oauth/authorize`);
  authorize.searchParams.set('response_type', 'code');
  authorize.searchParams.set('client_id', TV_CLIENT_ID);
  authorize.searchParams.set('redirect_uri', `${origin}${PATH}/callback`);
  authorize.searchParams.set('code_challenge', createHash('sha256').update(verifier).digest('base64url'));
  authorize.searchParams.set('code_challenge_method', 'S256');
  authorize.searchParams.set('state', state);
  const res = NextResponse.redirect(authorize.toString());
  res.cookies.set(STATE, state, cookieOpts(req, 600));
  res.cookies.set(PKCE, verifier, cookieOpts(req, 600));
  return res;
}

/** GET /api/tv/callback */
export async function tvCallback(req: NextRequest, fetchImpl: typeof fetch = fetch): Promise<NextResponse> {
  const origin = requestOrigin(req);
  const url = new URL(req.url);
  const back = (outcome: string) => {
    const res = NextResponse.redirect(`${origin}/terminal?tv=${outcome}`);
    res.cookies.set(STATE, '', { path: PATH, maxAge: 0 });
    res.cookies.set(PKCE, '', { path: PATH, maxAge: 0 });
    return res;
  };
  if (url.searchParams.get('error')) return back('denied');
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const verifier = req.cookies.get(PKCE)?.value;
  if (!code || !state || !verifier || state !== req.cookies.get(STATE)?.value) return back('badstate');
  const r = await tokenCall({ grant_type: 'authorization_code', code, redirect_uri: `${origin}${PATH}/callback`, code_verifier: verifier }, fetchImpl);
  if (!r.ok || !r.body.access_token || !r.body.refresh_token) {
    console.error(`[tv] code exchange failed ${r.status}: ${String(r.body.error ?? '').slice(0, 80)}`);
    return back('failed');
  }
  const res = back('connected');
  setTokens(req, res, r.body);
  return res;
}

/** GET /api/tv/token: the access token the player sends to hdtilt, refreshed when it is nearly out. */
export async function tvToken(req: NextRequest, fetchImpl: typeof fetch = fetch, now = Date.now()): Promise<NextResponse> {
  const site = tvSite();
  const rt = req.cookies.get(RT)?.value;
  if (!rt) return NextResponse.json({ connected: false, site }, { headers: noStore });
  const at = req.cookies.get(AT)?.value;
  const exp = Number(req.cookies.get(AT_EXP)?.value);
  if (at && Number.isFinite(exp) && exp - now > MIN_LEFT_MS) {
    return NextResponse.json({ connected: true, accessToken: at, expiresAt: exp, site }, { headers: noStore });
  }
  const r = await tokenCall({ grant_type: 'refresh_token', refresh_token: rt }, fetchImpl);
  if (r.ok && r.body.access_token) {
    const expiresAt = now + Math.max(60, Number(r.body.expires_in) || 3600) * 1000;
    const res = NextResponse.json({ connected: true, accessToken: r.body.access_token, expiresAt, site }, { headers: noStore });
    setTokens(req, res, r.body, now);
    return res;
  }
  // hdtilt says the grant is gone (revoked, replayed, expired): forget it. A
  // network failure is not that: keep the cookie and let the page retry.
  if (r.status === 400 || r.status === 401) {
    const res = NextResponse.json({ connected: false, site, reason: 'expired' }, { headers: noStore });
    clearTokens(res);
    return res;
  }
  return NextResponse.json({ connected: true, site, error: 'hdtilt.com did not answer; try again' }, { status: 503, headers: noStore });
}

/** POST /api/tv/disconnect */
export async function tvDisconnect(req: NextRequest, fetchImpl: typeof fetch = fetch): Promise<NextResponse> {
  const origin = req.headers.get('origin');
  if (origin && origin.replace(/\/$/, '') !== requestOrigin(req)) return NextResponse.json({ error: 'cross-site request refused' }, { status: 403 });
  const rt = req.cookies.get(RT)?.value;
  if (rt) {
    try {
      await fetchImpl(`${tvSite()}/oauth/revoke`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'b1dz-terminal-tv/1' },
        body: new URLSearchParams({ token: rt, client_id: TV_CLIENT_ID }).toString(),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      /* the cookie is cleared either way; the grant expires by itself */
    }
  }
  const res = NextResponse.json({ connected: false }, { headers: noStore });
  clearTokens(res);
  return res;
}
