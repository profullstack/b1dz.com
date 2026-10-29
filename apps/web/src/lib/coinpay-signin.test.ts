/**
 * Sign in with CoinPay: the account binds to the CoinPay sub only. An email
 * collision never takes over an existing account, linking needs a session,
 * a bad state or nonce is refused, and disconnect is refused when CoinPay is
 * the only way in.
 */
import { describe, expect, it } from 'vitest';
import {
  type CoinpayStore,
  type IdentityRow,
  decodePending,
  disconnectCoinpay,
  fetchCoinpayClaims,
  isPlaceholderEmail,
  placeholderEmail,
  resolveCoinpayUser,
  safeNext,
  sameState,
  startAuth,
} from './coinpay-signin';

const cfg = { clientId: 'cp_test', clientSecret: 'secret', base: 'https://coinpay.test', siteUrl: 'https://b1dz.test' };

function memoryStore(users: Record<string, string> = {}) {
  const rows: (IdentityRow & { coinpay_name: string | null })[] = [];
  let n = 0;
  const store: CoinpayStore & { users: Record<string, string>; rows: typeof rows } = {
    users,
    rows,
    async identityBySub(sub) { return rows.find((r) => r.coinpay_sub === sub) ?? null; },
    async identityByUser(id) { return rows.find((r) => r.user_id === id) ?? null; },
    async link(row) {
      if (rows.some((r) => r.coinpay_sub === row.coinpay_sub || r.user_id === row.user_id)) return 'conflict';
      rows.push(row);
      return 'ok';
    },
    async unlink(id) { const i = rows.findIndex((r) => r.user_id === id); if (i >= 0) rows.splice(i, 1); },
    async touch() {},
    async createUser() { const id = `new-${++n}`; users[id] = placeholderEmail(); return id; },
    async deleteUser(id) { delete users[id]; },
  };
  return store;
}

const claims = (sub: string, email: string | null) => ({ sub, email, name: 'Someone' });

describe('resolveCoinpayUser', () => {
  it('a first CoinPay login makes a new account with a placeholder email; the same sub returns to it', async () => {
    const store = memoryStore();
    const first = await resolveCoinpayUser({ mode: 'login', currentUserId: null, claims: claims('sub-1', 'a@example.com') }, store);
    expect(first).toMatchObject({ ok: true, action: 'created' });
    const id = (first as { userId: string }).userId;
    expect(isPlaceholderEmail(store.users[id])).toBe(true);
    expect(await resolveCoinpayUser({ mode: 'login', currentUserId: null, claims: claims('sub-1', 'a@example.com') }, store)).toEqual({ ok: true, userId: id, action: 'login' });
  });

  it('a CoinPay email equal to an existing user does NOT get that account', async () => {
    const store = memoryStore({ victim: 'victim@example.com' });
    const r = await resolveCoinpayUser({ mode: 'login', currentUserId: null, claims: claims('sub-attacker', 'victim@example.com') }, store);
    expect(r.ok).toBe(true);
    expect((r as { userId: string }).userId).not.toBe('victim');
    expect(await store.identityByUser('victim')).toBeNull();
  });

  it('connecting needs a session, and a sub bound elsewhere cannot be connected again', async () => {
    const store = memoryStore({ alice: 'alice@example.com', bob: 'bob@example.com' });
    expect(await resolveCoinpayUser({ mode: 'connect', currentUserId: null, claims: claims('sub-a', null) }, store)).toMatchObject({ ok: false, code: 'not_signed_in' });
    expect(await resolveCoinpayUser({ mode: 'connect', currentUserId: 'alice', claims: claims('sub-a', null) }, store)).toEqual({ ok: true, userId: 'alice', action: 'linked' });
    expect(await resolveCoinpayUser({ mode: 'login', currentUserId: null, claims: claims('sub-a', null) }, store)).toEqual({ ok: true, userId: 'alice', action: 'login' });
    expect(await resolveCoinpayUser({ mode: 'connect', currentUserId: 'bob', claims: claims('sub-a', null) }, store)).toMatchObject({ ok: false, code: 'linked_elsewhere' });
  });

  it('disconnect is refused when CoinPay is the only way in', async () => {
    const store = memoryStore({ alice: 'alice@example.com' });
    await resolveCoinpayUser({ mode: 'connect', currentUserId: 'alice', claims: claims('sub-a', null) }, store);
    const made = await resolveCoinpayUser({ mode: 'login', currentUserId: null, claims: claims('sub-b', null) }, store);
    const id = (made as { userId: string }).userId;
    expect(await disconnectCoinpay(id, store.users[id], store)).toMatchObject({ ok: false });
    expect(await disconnectCoinpay('alice', 'alice@example.com', store)).toEqual({ ok: true });
    expect(await store.identityByUser('alice')).toBeNull();
  });
});

describe('the OAuth round trip', () => {
  it('starts with PKCE S256, state, nonce and the exact redirect; the cookie carries them', () => {
    const { url, cookie } = startAuth(cfg, 'login', '//evil.example');
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe('https://coinpay.test/api/oauth/authorize');
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('redirect_uri')).toBe('https://b1dz.test/api/v1/coinpay/oauth/callback');
    expect(u.searchParams.get('scope')).toBe('openid profile email');
    const pending = decodePending(cookie)!;
    expect(pending.state).toBe(u.searchParams.get('state'));
    expect(pending.nonce).toBe(u.searchParams.get('nonce'));
    expect(pending.next).toBe('/dashboard');
    expect(sameState(pending.state, 'forged')).toBe(false);
    expect(sameState(pending.state, null)).toBe(false);
  });

  it('refuses an id_token whose nonce does not match, and sends the secret + verifier', async () => {
    const sent: URLSearchParams[] = [];
    const fake = (nonce: string) =>
      (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/api/oauth/token')) {
          sent.push(new URLSearchParams(String(init?.body)));
          const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
          return Response.json({
            access_token: 'at',
            id_token: [b64({ alg: 'RS256' }), b64({ iss: cfg.base, aud: cfg.clientId, sub: 's', exp: Math.floor(Date.now() / 1000) + 300, nonce }), 'x'].join('.'),
          });
        }
        return Response.json({ sub: 's', email: 'x@example.com', email_verified: false });
      }) as typeof fetch;
    expect(await fetchCoinpayClaims(cfg, { code: 'c', verifier: 'v'.repeat(43), nonce: 'right' }, fake('wrong'))).toMatchObject({ ok: false });
    const ok = await fetchCoinpayClaims(cfg, { code: 'c', verifier: 'v'.repeat(43), nonce: 'right' }, fake('right'));
    expect(ok).toEqual({ ok: true, claims: { sub: 's', email: 'x@example.com', name: null } });
    expect(sent[0].get('client_secret')).toBe('secret');
    expect(sent[0].get('code_verifier')).toBe('v'.repeat(43));
  });

  it('only same-site next paths survive', () => {
    expect(safeNext('https://evil.example')).toBe('/dashboard');
    expect(safeNext('/\\evil')).toBe('/dashboard');
    expect(safeNext('/console')).toBe('/console');
  });
});
