/**
 * Sign in with CoinPay (2026-10-29). CoinPay is the fleet's master account: a
 * CoinPay user can sign in to b1dz, and a signed-in user can connect their
 * CoinPay account from Settings.
 *
 * Confidential OIDC client: authorization code + PKCE (S256) + state + nonce,
 * redirect https://b1dz.com/api/v1/coinpay/oauth/callback, scopes
 * "openid profile email". The code exchange, id_token claim checks
 * (iss/aud/exp/nonce) and the userinfo sub match come from
 * @profullstack/coinpay-onboard/oauth. State, verifier and nonce ride in a
 * short-lived httpOnly cookie scoped to the OAuth routes.
 *
 * STANDING rule: a CoinPay login binds to the CoinPay `sub` in
 * public.coinpay_identities. It never signs in to an existing account because
 * the CoinPay email matches (CoinPay never verifies emails), never stores that
 * email as the account's email and never grants anything from it. Linking to
 * an existing account happens only from Settings while signed in to it. A
 * first CoinPay login with no link creates a NEW account whose auth email is a
 * random placeholder; the CoinPay email is kept on the identity row as
 * unverified contact info.
 */
import { randomBytes } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { authorizeUrl, finishSignIn, pkce, randomToken, sameState, SIGN_IN_SCOPES } from '@profullstack/coinpay-onboard/oauth';

export const CALLBACK_PATH = '/api/v1/coinpay/oauth/callback';
export const OAUTH_COOKIE = 'b1dz_coinpay_oauth';
export const OAUTH_COOKIE_PATH = '/api/v1/coinpay/oauth';
export const OAUTH_COOKIE_MAX_AGE = 600;
/** Auth emails of accounts a CoinPay login created. Nobody receives mail here. */
export const PLACEHOLDER_EMAIL_DOMAIN = 'coinpay-users.b1dz.com';

// Read at request time with a non-literal key: Next inlines process.env.NAME
// at build time, server code included, which would bake a missing secret in.
function runtimeEnv(name: string): string {
  const v = (process.env as Record<string, string | undefined>)[name];
  return typeof v === 'string' ? v.trim() : '';
}

export type CoinpayConfig = { clientId: string; clientSecret: string; base?: string; siteUrl: string };

export function coinpayConfig(): CoinpayConfig | null {
  const clientId = runtimeEnv('COINPAY_OAUTH_CLIENT_ID');
  const clientSecret = runtimeEnv('COINPAY_OAUTH_CLIENT_SECRET');
  if (!clientId || !clientSecret) return null;
  const siteUrl = (runtimeEnv('NEXT_PUBLIC_SITE_URL') || 'https://b1dz.com').replace(/\/+$/, '');
  return { clientId, clientSecret, base: runtimeEnv('COINPAY_OAUTH_BASE') || undefined, siteUrl };
}

export const redirectUri = (cfg: Pick<CoinpayConfig, 'siteUrl'>) => cfg.siteUrl + CALLBACK_PATH;

export type OAuthMode = 'login' | 'connect';
export type PendingAuth = { state: string; verifier: string; nonce: string; mode: OAuthMode; next: string };

/** Only same-site paths; anything else falls back to the default landing. */
export function safeNext(next: string | null | undefined, mode: OAuthMode = 'login'): string {
  const fallback = mode === 'connect' ? '/settings' : '/dashboard';
  if (!next || typeof next !== 'string') return fallback;
  if (!next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\') || /[\r\n\t]/.test(next)) return fallback;
  if (next.length > 512) return fallback;
  return next;
}

export function startAuth(cfg: CoinpayConfig, mode: OAuthMode, next: string | null): { url: string; cookie: string } {
  const { verifier, challenge } = pkce();
  const pending: PendingAuth = { state: randomToken(), verifier, nonce: randomToken(), mode, next: safeNext(next, mode) };
  const url = authorizeUrl({
    clientId: cfg.clientId,
    redirectUri: redirectUri(cfg),
    state: pending.state,
    nonce: pending.nonce,
    challenge,
    scopes: SIGN_IN_SCOPES,
    base: cfg.base,
  });
  return { url, cookie: encodePending(pending) };
}

export function encodePending(p: PendingAuth): string {
  return Buffer.from(JSON.stringify({ s: p.state, v: p.verifier, n: p.nonce, m: p.mode, r: p.next })).toString('base64url');
}

export function decodePending(raw: string | null | undefined): PendingAuth | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (!o || typeof o.s !== 'string' || typeof o.v !== 'string' || typeof o.n !== 'string') return null;
    if (o.m !== 'login' && o.m !== 'connect') return null;
    return { state: o.s, verifier: o.v, nonce: o.n, mode: o.m, next: safeNext(String(o.r ?? ''), o.m) };
  } catch {
    return null;
  }
}

export { sameState };

export type CoinpayClaims = { sub: string; email: string | null; name: string | null };

/** Code -> tokens -> id_token checks -> userinfo (sub must match). */
export async function fetchCoinpayClaims(
  cfg: CoinpayConfig,
  input: { code: string; verifier: string; nonce: string },
  doFetch?: typeof fetch,
): Promise<{ ok: true; claims: CoinpayClaims } | { ok: false; error: string }> {
  try {
    const r = await finishSignIn({
      code: input.code,
      verifier: input.verifier,
      nonce: input.nonce,
      clientId: cfg.clientId,
      clientSecret: cfg.clientSecret,
      redirectUri: redirectUri(cfg),
      base: cfg.base,
      fetch: doFetch,
    });
    return {
      ok: true,
      claims: {
        sub: r.sub,
        email: r.email && r.email.includes('@') ? r.email.slice(0, 320) : null,
        name: r.name ? r.name.trim().slice(0, 200) : null,
      },
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'CoinPay sign-in failed' };
  }
}

// ---------------------------------------------------------------- store

export type IdentityRow = { user_id: string; coinpay_sub: string; coinpay_email: string | null; created_via: 'connect' | 'signup' };

export interface CoinpayStore {
  identityBySub(sub: string): Promise<IdentityRow | null>;
  identityByUser(userId: string): Promise<IdentityRow | null>;
  /** Insert; "conflict" when the sub or the user is already bound. */
  link(row: IdentityRow & { coinpay_name: string | null }): Promise<'ok' | 'conflict'>;
  unlink(userId: string): Promise<void>;
  touch(sub: string): Promise<void>;
  /** A brand-new auth user with a random placeholder email (confirmed: the domain is ours). */
  createUser(input: { name: string | null }): Promise<string>;
  deleteUser(userId: string): Promise<void>;
}

export function isPlaceholderEmail(email: string | null | undefined): boolean {
  return !!email && email.toLowerCase().endsWith('@' + PLACEHOLDER_EMAIL_DOMAIN);
}

export function placeholderEmail(): string {
  return `cp-${randomBytes(12).toString('hex')}@${PLACEHOLDER_EMAIL_DOMAIN}`;
}

export type Resolution =
  | { ok: true; userId: string; action: 'login' | 'created' | 'linked' }
  | { ok: false; error: string; code: 'not_signed_in' | 'linked_elsewhere' | 'already_connected' };

/**
 * Decide which b1dz user a verified CoinPay sub belongs to. Never looks at the
 * email: a CoinPay login whose email equals an existing user's gets a NEW
 * account (or the one already bound to its sub), never that user's.
 */
export async function resolveCoinpayUser(
  input: { mode: OAuthMode; currentUserId: string | null; claims: CoinpayClaims },
  store: CoinpayStore,
): Promise<Resolution> {
  const { claims } = input;
  const bound = await store.identityBySub(claims.sub);

  if (input.mode === 'connect') {
    if (!input.currentUserId) return { ok: false, code: 'not_signed_in', error: 'Sign in to b1dz first, then connect CoinPay from Settings.' };
    if (bound) {
      if (bound.user_id === input.currentUserId) return { ok: true, userId: bound.user_id, action: 'linked' };
      return { ok: false, code: 'linked_elsewhere', error: 'That CoinPay account is already connected to another b1dz account.' };
    }
    const mine = await store.identityByUser(input.currentUserId);
    if (mine) return { ok: false, code: 'already_connected', error: 'This b1dz account is already connected to a different CoinPay account. Disconnect it first.' };
    const r = await store.link({ user_id: input.currentUserId, coinpay_sub: claims.sub, coinpay_email: claims.email, coinpay_name: claims.name, created_via: 'connect' });
    if (r === 'conflict') return { ok: false, code: 'linked_elsewhere', error: 'That CoinPay account was just connected elsewhere.' };
    return { ok: true, userId: input.currentUserId, action: 'linked' };
  }

  if (bound) {
    await store.touch(claims.sub);
    return { ok: true, userId: bound.user_id, action: 'login' };
  }
  const userId = await store.createUser({ name: claims.name });
  const r = await store.link({ user_id: userId, coinpay_sub: claims.sub, coinpay_email: claims.email, coinpay_name: claims.name, created_via: 'signup' });
  if (r === 'conflict') {
    // Lost a race with a parallel first login for the same sub: keep theirs.
    await store.deleteUser(userId).catch(() => {});
    const again = await store.identityBySub(claims.sub);
    if (again) return { ok: true, userId: again.user_id, action: 'login' };
    throw new Error('coinpay identity conflict');
  }
  return { ok: true, userId, action: 'created' };
}

/** Disconnect is refused when CoinPay is the only way into the account. */
export async function disconnectCoinpay(
  userId: string,
  authEmail: string | null,
  store: CoinpayStore,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const mine = await store.identityByUser(userId);
  if (!mine) return { ok: true };
  if (!authEmail || isPlaceholderEmail(authEmail)) {
    return { ok: false, error: 'CoinPay is the only way to sign in to this account, so it cannot be disconnected.' };
  }
  await store.unlink(userId);
  return { ok: true };
}

export function supabaseCoinpayStore(sb: SupabaseClient): CoinpayStore {
  const cols = 'user_id, coinpay_sub, coinpay_email, created_via';
  return {
    async identityBySub(sub) {
      const r = await sb.from('coinpay_identities').select(cols).eq('coinpay_sub', sub).maybeSingle();
      if (r.error) throw new Error(r.error.message);
      return (r.data as IdentityRow | null) ?? null;
    },
    async identityByUser(userId) {
      const r = await sb.from('coinpay_identities').select(cols).eq('user_id', userId).maybeSingle();
      if (r.error) throw new Error(r.error.message);
      return (r.data as IdentityRow | null) ?? null;
    },
    async link(row) {
      const r = await sb.from('coinpay_identities').insert({ ...row, last_login_at: new Date().toISOString() });
      if (r.error) {
        if (r.error.code === '23505') return 'conflict';
        throw new Error(r.error.message);
      }
      return 'ok';
    },
    async unlink(userId) {
      const r = await sb.from('coinpay_identities').delete().eq('user_id', userId);
      if (r.error) throw new Error(r.error.message);
    },
    async touch(sub) {
      await sb.from('coinpay_identities').update({ last_login_at: new Date().toISOString() }).eq('coinpay_sub', sub);
    },
    async createUser({ name }) {
      const r = await sb.auth.admin.createUser({
        email: placeholderEmail(),
        email_confirm: true,
        // user_metadata is user-editable: nothing here is ever trusted.
        user_metadata: { full_name: name ?? 'CoinPay user', signup_via: 'coinpay' },
        app_metadata: { signup_via: 'coinpay' },
      });
      if (r.error || !r.data.user) throw new Error(r.error?.message ?? 'createUser failed');
      return r.data.user.id;
    },
    async deleteUser(userId) {
      await sb.auth.admin.deleteUser(userId);
    },
  };
}

/**
 * A magic-link token hash for the user's OWN auth email, minted server side
 * (nothing is emailed). The caller redeems it with verifyOtp on the cookie
 * client, which sets the normal Supabase session cookies. Refuses an account
 * whose email is not confirmed: redeeming the link would confirm it.
 */
export async function mintMagicLinkHash(sb: SupabaseClient, userId: string): Promise<{ ok: true; tokenHash: string } | { ok: false; error: string }> {
  const u = await sb.auth.admin.getUserById(userId);
  const user = u.data?.user;
  if (u.error || !user?.email) return { ok: false, error: 'account not found' };
  if (!user.email_confirmed_at) return { ok: false, error: "Confirm this account's email before signing in with CoinPay." };
  const link = await sb.auth.admin.generateLink({ type: 'magiclink', email: user.email });
  const tokenHash = link.data?.properties?.hashed_token;
  if (link.error || !tokenHash) return { ok: false, error: 'could not start a session' };
  return { ok: true, tokenHash };
}
