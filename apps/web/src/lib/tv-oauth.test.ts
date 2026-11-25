import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { TV_CLIENT_ID, tvCallback, tvDisconnect, tvStart, tvToken } from './tv-oauth';

function req(path: string, cookies: Record<string, string> = {}, init: { method?: string; headers?: Record<string, string> } = {}) {
  const cookie = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
  return new NextRequest(`https://b1dz.com${path}`, { method: init.method ?? 'GET', headers: { host: 'b1dz.com', ...(cookie ? { cookie } : {}), ...init.headers } });
}
const jar = (res: Response) => Object.fromEntries((res.headers.getSetCookie?.() ?? []).map((c) => [c.split('=')[0], c]));
const valueOf = (setCookie: string) => decodeURIComponent(setCookie.split(';')[0].split('=').slice(1).join('='));
const tokens = (over = {}) => new Response(JSON.stringify({ access_token: 'ht_at_new', refresh_token: 'ht_rt_new', expires_in: 3600, token_type: 'Bearer', ...over }), { status: 200 });

describe('tv connect', () => {
  it('starts a PKCE authorization at hdtilt with the exact callback', () => {
    const res = tvStart(req('/api/tv/start'));
    const to = new URL(res.headers.get('location')!);
    expect(`${to.origin}${to.pathname}`).toBe('https://hdtilt.com/oauth/authorize');
    expect(to.searchParams.get('client_id')).toBe(TV_CLIENT_ID);
    expect(to.searchParams.get('redirect_uri')).toBe('https://b1dz.com/api/tv/callback');
    expect(to.searchParams.get('code_challenge_method')).toBe('S256');
    const c = jar(res);
    const verifier = valueOf(c.tv_pkce);
    expect(to.searchParams.get('code_challenge')).toBe(createHash('sha256').update(verifier).digest('base64url'));
    expect(to.searchParams.get('state')).toBe(valueOf(c.tv_state));
    expect(c.tv_pkce).toMatch(/HttpOnly/i);
    expect(c.tv_pkce).toMatch(/Path=\/api\/tv/i);
    expect(c.tv_pkce).toMatch(/Secure/i);
  });

  it('exchanges the code with the verifier and keeps the tokens in httpOnly cookies', async () => {
    const fetchImpl = vi.fn(async () => tokens());
    const res = await tvCallback(req('/api/tv/callback?code=abc&state=s1', { tv_state: 's1', tv_pkce: 'ver' }), fetchImpl as unknown as typeof fetch);
    expect(res.headers.get('location')).toBe('https://b1dz.com/terminal?tv=connected');
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://hdtilt.com/oauth/token');
    expect(Object.fromEntries(new URLSearchParams(String(init.body)))).toEqual({
      grant_type: 'authorization_code',
      code: 'abc',
      redirect_uri: 'https://b1dz.com/api/tv/callback',
      code_verifier: 'ver',
      client_id: 'b1dz-web',
    });
    const c = jar(res);
    expect(valueOf(c.tv_rt)).toBe('ht_rt_new');
    expect(valueOf(c.tv_at)).toBe('ht_at_new');
    expect(c.tv_rt).toMatch(/HttpOnly/i);
    expect(c.tv_rt).toMatch(/Max-Age=7776000/);
    expect(c.tv_state).toMatch(/Max-Age=0/);
  });

  it('refuses a callback whose state does not match, without calling hdtilt', async () => {
    const fetchImpl = vi.fn(async () => tokens());
    for (const r of [req('/api/tv/callback?code=abc&state=evil', { tv_state: 's1', tv_pkce: 'ver' }), req('/api/tv/callback?code=abc&state=s1', { tv_state: 's1' }), req('/api/tv/callback?code=abc&state=s1')]) {
      const res = await tvCallback(r, fetchImpl as unknown as typeof fetch);
      expect(res.headers.get('location')).toBe('https://b1dz.com/terminal?tv=badstate');
    }
    expect(fetchImpl).not.toHaveBeenCalled();
    expect((await tvCallback(req('/api/tv/callback?error=access_denied&state=s1', { tv_state: 's1', tv_pkce: 'v' }))).headers.get('location')).toMatch(/tv=denied/);
    const failed = await tvCallback(req('/api/tv/callback?code=abc&state=s1', { tv_state: 's1', tv_pkce: 'ver' }), (async () => new Response('{"error":"invalid_grant"}', { status: 400 })) as unknown as typeof fetch);
    expect(failed.headers.get('location')).toMatch(/tv=failed/);
  });
});

describe('tv token', () => {
  const now = 1_800_000_000_000;

  it('says not connected with no refresh token', async () => {
    expect(await (await tvToken(req('/api/tv/token'))).json()).toEqual({ connected: false, site: 'https://hdtilt.com' });
  });

  it('hands out the cached access token while it has time left, without touching hdtilt', async () => {
    const fetchImpl = vi.fn();
    const res = await tvToken(req('/api/tv/token', { tv_rt: 'rt', tv_at: 'ht_at_cached', tv_at_exp: String(now + 30 * 60_000) }), fetchImpl as unknown as typeof fetch, now);
    expect(await res.json()).toEqual({ connected: true, accessToken: 'ht_at_cached', expiresAt: now + 30 * 60_000, site: 'https://hdtilt.com' });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('refreshes when the access token is nearly out and stores the rotated pair', async () => {
    const fetchImpl = vi.fn(async () => tokens({ access_token: 'ht_at_2', refresh_token: 'ht_rt_2' }));
    const res = await tvToken(req('/api/tv/token', { tv_rt: 'ht_rt_1', tv_at: 'old', tv_at_exp: String(now + 60_000) }), fetchImpl as unknown as typeof fetch, now);
    expect(await res.json()).toMatchObject({ connected: true, accessToken: 'ht_at_2', expiresAt: now + 3_600_000 });
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(Object.fromEntries(new URLSearchParams(String(init.body)))).toEqual({ grant_type: 'refresh_token', refresh_token: 'ht_rt_1', client_id: 'b1dz-web' });
    const c = jar(res);
    expect(valueOf(c.tv_rt)).toBe('ht_rt_2');
    expect(valueOf(c.tv_at)).toBe('ht_at_2');
  });

  it('forgets a grant hdtilt has ended, but keeps it through an outage', async () => {
    const gone = await tvToken(req('/api/tv/token', { tv_rt: 'dead' }), (async () => new Response('{"error":"invalid_grant"}', { status: 400 })) as unknown as typeof fetch, now);
    expect(await gone.json()).toMatchObject({ connected: false, reason: 'expired' });
    expect(jar(gone).tv_rt).toMatch(/Max-Age=0/);
    const down = await tvToken(req('/api/tv/token', { tv_rt: 'fine' }), (async () => { throw new Error('ECONNRESET'); }) as unknown as typeof fetch, now);
    expect(down.status).toBe(503);
    expect(jar(down).tv_rt).toBeUndefined();
  });
});

describe('tv disconnect', () => {
  it('revokes at hdtilt and clears the cookies', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}'));
    const res = await tvDisconnect(req('/api/tv/disconnect', { tv_rt: 'ht_rt_1' }, { method: 'POST', headers: { origin: 'https://b1dz.com' } }), fetchImpl as unknown as typeof fetch);
    expect(await res.json()).toEqual({ connected: false });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://hdtilt.com/oauth/revoke');
    expect(String(init.body)).toContain('token=ht_rt_1');
    expect(jar(res).tv_rt).toMatch(/Max-Age=0/);
  });

  it('refuses a cross-site request', async () => {
    const fetchImpl = vi.fn();
    const res = await tvDisconnect(req('/api/tv/disconnect', { tv_rt: 'x' }, { method: 'POST', headers: { origin: 'https://evil.example' } }), fetchImpl as unknown as typeof fetch);
    expect(res.status).toBe(403);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
