/**
 * Passkeys (WebAuthn) for b1dz sign-in, on @simplewebauthn/server.
 *
 * - Add: only from Settings, inside a cookie session (never a bearer or agent
 *   token), so a passkey can never be how an account is first taken over.
 * - Sign in: a discoverable credential (no email typed). The verified
 *   credential's owner gets a normal Supabase session through the same
 *   server-minted magic-link hash CoinPay sign-in uses (mintMagicLinkHash).
 * - Every challenge is a row consumed by its verify step: one attempt each,
 *   five minutes. The browser holds only the row id in an httpOnly cookie.
 * - Every mutating route checks the Origin header. A software authenticator
 *   can sign any clientDataJSON it likes, so the WebAuthn origin check alone
 *   does not stop a cross-site POST that registers an attacker's key.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';

export const CHALLENGE_COOKIE = 'b1dz_passkey';
export const CHALLENGE_COOKIE_PATH = '/api/auth/passkey';
export const CHALLENGE_TTL_SECONDS = 300;
export const MAX_PASSKEYS_PER_USER = 20;
const RP_NAME = 'b1dz';

// Read at request time with a non-literal key: Next inlines process.env.NAME
// at build time, server code included.
function runtimeEnv(name: string): string {
  const v = (process.env as Record<string, string | undefined>)[name];
  return typeof v === 'string' ? v.trim() : '';
}

export type RpConfig = { rpID: string; origin: string };

export function rpConfig(siteUrl = runtimeEnv('NEXT_PUBLIC_SITE_URL') || 'https://b1dz.com'): RpConfig {
  const u = new URL(siteUrl);
  return { rpID: u.hostname, origin: u.origin };
}

/** Mutating passkey routes accept only a same-origin browser request. */
export function sameOrigin(originHeader: string | null, cfg: RpConfig): boolean {
  return !!originHeader && originHeader === cfg.origin;
}

const b64u = {
  encode: (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url'),
  decode: (s: string) => new Uint8Array(Buffer.from(s, 'base64url')),
};

export function cleanName(name: unknown): string {
  if (typeof name !== 'string') return 'Passkey';
  const n = name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 60);
  return n || 'Passkey';
}

// ---------------------------------------------------------------- store

export type PasskeyRow = {
  id: string;
  user_id: string;
  public_key: string;
  counter: number;
  transports: string[];
  device_type: 'singleDevice' | 'multiDevice';
  backed_up: boolean;
  aaguid: string | null;
  name: string;
  created_at?: string;
  last_used_at?: string | null;
};

export type PasskeySummary = Pick<PasskeyRow, 'id' | 'name' | 'device_type' | 'backed_up' | 'created_at' | 'last_used_at'>;

export type ChallengePurpose = 'register' | 'login';

export interface PasskeyStore {
  saveChallenge(input: { challenge: string; purpose: ChallengePurpose; userId: string | null }): Promise<string>;
  /** Deletes and returns the row if it exists, matches the purpose and has not expired. */
  takeChallenge(id: string, purpose: ChallengePurpose): Promise<{ challenge: string; userId: string | null } | null>;
  byId(credentialId: string): Promise<PasskeyRow | null>;
  byUser(userId: string): Promise<PasskeyRow[]>;
  /** "conflict" when the credential id is already registered. */
  insert(row: PasskeyRow): Promise<'ok' | 'conflict'>;
  touch(credentialId: string, counter: number): Promise<void>;
  remove(userId: string, credentialId: string): Promise<boolean>;
  rename(userId: string, credentialId: string, name: string): Promise<boolean>;
}

// ---------------------------------------------------------------- register

export async function startRegistration(
  cfg: RpConfig,
  user: { id: string; email: string | null; displayName: string },
  store: PasskeyStore,
): Promise<{ ok: true; challengeId: string; options: PublicKeyCredentialCreationOptionsJSON } | { ok: false; error: string }> {
  const existing = await store.byUser(user.id);
  if (existing.length >= MAX_PASSKEYS_PER_USER) return { ok: false, error: `You already have ${MAX_PASSKEYS_PER_USER} passkeys. Remove one first.` };
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: cfg.rpID,
    userID: new TextEncoder().encode(user.id),
    userName: user.email ?? user.displayName,
    userDisplayName: user.displayName,
    attestationType: 'none',
    excludeCredentials: existing.map((p) => ({ id: p.id, transports: p.transports as AuthenticatorTransportFuture[] })),
    // Discoverable, so sign-in needs no email; verified, so it is a full factor.
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
  });
  const challengeId = await store.saveChallenge({ challenge: options.challenge, purpose: 'register', userId: user.id });
  return { ok: true, challengeId, options };
}

export async function finishRegistration(
  cfg: RpConfig,
  input: { userId: string; challengeId: string | null | undefined; response: RegistrationResponseJSON; name?: unknown },
  store: PasskeyStore,
): Promise<{ ok: true; passkey: PasskeySummary } | { ok: false; error: string }> {
  if (!input.challengeId) return { ok: false, error: 'Passkey setup expired. Try again.' };
  const ch = await store.takeChallenge(input.challengeId, 'register');
  if (!ch || ch.userId !== input.userId) return { ok: false, error: 'Passkey setup expired. Try again.' };
  let v;
  try {
    v = await verifyRegistrationResponse({
      response: input.response,
      expectedChallenge: ch.challenge,
      expectedOrigin: cfg.origin,
      expectedRPID: cfg.rpID,
      requireUserVerification: true,
    });
  } catch (e) {
    console.warn('[passkey] registration rejected', e instanceof Error ? e.message : e);
    return { ok: false, error: 'That passkey could not be verified.' };
  }
  if (!v.verified) return { ok: false, error: 'That passkey could not be verified.' };
  const info = v.registrationInfo;
  const row: PasskeyRow = {
    id: info.credential.id,
    user_id: input.userId,
    public_key: b64u.encode(info.credential.publicKey),
    counter: info.credential.counter,
    transports: info.credential.transports ?? input.response.response.transports ?? [],
    device_type: info.credentialDeviceType,
    backed_up: info.credentialBackedUp,
    aaguid: info.aaguid || null,
    name: cleanName(input.name),
  };
  if ((await store.insert(row)) === 'conflict') return { ok: false, error: 'That passkey is already registered.' };
  return { ok: true, passkey: { id: row.id, name: row.name, device_type: row.device_type, backed_up: row.backed_up, created_at: new Date().toISOString(), last_used_at: null } };
}

// ---------------------------------------------------------------- sign in

export async function startLogin(
  cfg: RpConfig,
  store: PasskeyStore,
): Promise<{ challengeId: string; options: PublicKeyCredentialRequestOptionsJSON }> {
  const options = await generateAuthenticationOptions({ rpID: cfg.rpID, userVerification: 'required' });
  const challengeId = await store.saveChallenge({ challenge: options.challenge, purpose: 'login', userId: null });
  return { challengeId, options };
}

const LOGIN_FAILED = 'That passkey did not sign you in. Try again, or use email.';

/** Verifies an assertion and returns the owner's user id. */
export async function finishLogin(
  cfg: RpConfig,
  input: { challengeId: string | null | undefined; response: AuthenticationResponseJSON },
  store: PasskeyStore,
): Promise<{ ok: true; userId: string } | { ok: false; error: string }> {
  if (!input.challengeId) return { ok: false, error: 'Passkey sign-in expired. Try again.' };
  const ch = await store.takeChallenge(input.challengeId, 'login');
  if (!ch) return { ok: false, error: 'Passkey sign-in expired. Try again.' };
  const id = typeof input.response?.id === 'string' ? input.response.id : '';
  const pk = id ? await store.byId(id) : null;
  if (!pk) return { ok: false, error: 'This passkey is not registered on b1dz. It may have been removed.' };

  // The authenticator's user handle must name the same account the
  // credential is stored under.
  const handle = input.response.response?.userHandle;
  if (handle) {
    let owner = '';
    try { owner = new TextDecoder().decode(b64u.decode(handle)); } catch { /* falls through */ }
    if (owner !== pk.user_id) return { ok: false, error: LOGIN_FAILED };
  }

  let v;
  try {
    v = await verifyAuthenticationResponse({
      response: input.response,
      expectedChallenge: ch.challenge,
      expectedOrigin: cfg.origin,
      expectedRPID: cfg.rpID,
      requireUserVerification: true,
      credential: {
        id: pk.id,
        publicKey: b64u.decode(pk.public_key),
        counter: Number(pk.counter) || 0,
        transports: pk.transports as AuthenticatorTransportFuture[],
      },
    });
  } catch (e) {
    console.warn('[passkey] assertion rejected', e instanceof Error ? e.message : e);
    return { ok: false, error: LOGIN_FAILED };
  }
  if (!v.verified) return { ok: false, error: LOGIN_FAILED };
  await store.touch(pk.id, v.authenticationInfo.newCounter);
  return { ok: true, userId: pk.user_id };
}

// ---------------------------------------------------------------- supabase

export function supabasePasskeyStore(sb: SupabaseClient): PasskeyStore {
  const cols = 'id, user_id, public_key, counter, transports, device_type, backed_up, aaguid, name, created_at, last_used_at';
  return {
    async saveChallenge({ challenge, purpose, userId }) {
      // Opportunistic sweep of abandoned ceremonies.
      await sb.from('passkey_challenges').delete().lt('expires_at', new Date().toISOString());
      const r = await sb
        .from('passkey_challenges')
        .insert({ challenge, purpose, user_id: userId, expires_at: new Date(Date.now() + CHALLENGE_TTL_SECONDS * 1000).toISOString() })
        .select('id')
        .single();
      if (r.error || !r.data) throw new Error(r.error?.message ?? 'challenge insert failed');
      return (r.data as { id: string }).id;
    },
    async takeChallenge(id, purpose) {
      if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
      const r = await sb
        .from('passkey_challenges')
        .delete()
        .eq('id', id)
        .eq('purpose', purpose)
        .gt('expires_at', new Date().toISOString())
        .select('challenge, user_id');
      if (r.error) throw new Error(r.error.message);
      const row = (r.data as { challenge: string; user_id: string | null }[] | null)?.[0];
      return row ? { challenge: row.challenge, userId: row.user_id } : null;
    },
    async byId(credentialId) {
      const r = await sb.from('passkeys').select(cols).eq('id', credentialId).maybeSingle();
      if (r.error) throw new Error(r.error.message);
      return (r.data as PasskeyRow | null) ?? null;
    },
    async byUser(userId) {
      const r = await sb.from('passkeys').select(cols).eq('user_id', userId).order('created_at', { ascending: true });
      if (r.error) throw new Error(r.error.message);
      return (r.data as PasskeyRow[] | null) ?? [];
    },
    async insert(row) {
      const r = await sb.from('passkeys').insert(row);
      if (r.error) {
        if (r.error.code === '23505') return 'conflict';
        throw new Error(r.error.message);
      }
      return 'ok';
    },
    async touch(credentialId, counter) {
      await sb.from('passkeys').update({ counter, last_used_at: new Date().toISOString() }).eq('id', credentialId);
    },
    async remove(userId, credentialId) {
      const r = await sb.from('passkeys').delete().eq('user_id', userId).eq('id', credentialId).select('id');
      if (r.error) throw new Error(r.error.message);
      return (r.data?.length ?? 0) > 0;
    },
    async rename(userId, credentialId, name) {
      const r = await sb.from('passkeys').update({ name }).eq('user_id', userId).eq('id', credentialId).select('id');
      if (r.error) throw new Error(r.error.message);
      return (r.data?.length ?? 0) > 0;
    },
  };
}

export function summarize(p: PasskeyRow): PasskeySummary {
  return { id: p.id, name: p.name, device_type: p.device_type, backed_up: p.backed_up, created_at: p.created_at, last_used_at: p.last_used_at ?? null };
}
