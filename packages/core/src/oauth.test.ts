import { afterEach, describe, expect, it, vi } from 'vitest';
import { OAUTH_PROVIDERS, isOAuthConfigured, pkceChallenge, refreshAccessToken, tokenRequest } from './oauth.js';

const KEYS = ['MOOMOO_OAUTH_CLIENT_ID', 'TRADIER_OAUTH_CLIENT_ID', 'TRADIER_OAUTH_CLIENT_SECRET'];
afterEach(() => {
  for (const k of KEYS) delete process.env[k];
});

describe('public OAuth client (moomoo)', () => {
  const moomoo = OAUTH_PROVIDERS.moomoo;

  it('is configured by a client id alone', () => {
    expect(isOAuthConfigured(moomoo)).toBe(false);
    process.env.MOOMOO_OAUTH_CLIENT_ID = 'cid';
    expect(isOAuthConfigured(moomoo)).toBe(true);
  });

  it('puts the client id in the body and sends no secret', () => {
    process.env.MOOMOO_OAUTH_CLIENT_ID = 'cid';
    const r = tokenRequest(moomoo, { grant_type: 'authorization_code', code: 'abc', redirect_uri: 'https://b1dz.com/api/oauth/moomoo/callback', code_verifier: 'v' });
    expect(r.headers.Authorization).toBeUndefined();
    expect(Object.fromEntries(new URLSearchParams(r.body))).toEqual({
      grant_type: 'authorization_code',
      code: 'abc',
      redirect_uri: 'https://b1dz.com/api/oauth/moomoo/callback',
      code_verifier: 'v',
      client_id: 'cid',
    });
  });

  it('computes the S256 challenge (RFC 7636 appendix B vector)', async () => {
    expect(await pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  it('refreshes with the client id and keeps the old refresh token when none comes back', async () => {
    process.env.MOOMOO_OAUTH_CLIENT_ID = 'cid';
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ access_token: 'new', expires_in: 7200, token_type: 'Bearer' }), { status: 200 }));
    const tok = await refreshAccessToken(moomoo, 'r1', fetchImpl as unknown as typeof fetch);
    expect(tok).toMatchObject({ access_token: 'new', expires_in: 7200 });
    expect(tok.refresh_token).toBeUndefined();
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://webapi.moomoo.com/oauth2/token');
    expect(Object.fromEntries(new URLSearchParams(String(init.body)))).toEqual({ grant_type: 'refresh_token', refresh_token: 'r1', client_id: 'cid' });
  });
});

describe('confidential OAuth client (tradier)', () => {
  const tradier = OAUTH_PROVIDERS.tradier;

  it('needs both id and secret, and sends HTTP Basic', () => {
    process.env.TRADIER_OAUTH_CLIENT_ID = 'id';
    expect(isOAuthConfigured(tradier)).toBe(false);
    expect(() => tokenRequest(tradier, { grant_type: 'refresh_token', refresh_token: 'r' })).toThrow(/not configured/);
    process.env.TRADIER_OAUTH_CLIENT_SECRET = 'sec';
    expect(isOAuthConfigured(tradier)).toBe(true);
    const r = tokenRequest(tradier, { grant_type: 'refresh_token', refresh_token: 'r' });
    expect(r.headers.Authorization).toBe(`Basic ${Buffer.from('id:sec').toString('base64')}`);
    expect(r.body).not.toContain('client_id');
  });
});
