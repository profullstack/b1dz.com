import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { isoCBOR } from '@simplewebauthn/server/helpers';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import {
  cleanName,
  finishLogin,
  finishRegistration,
  MAX_PASSKEYS_PER_USER,
  rpConfig,
  sameOrigin,
  startLogin,
  startRegistration,
  type ChallengePurpose,
  type PasskeyRow,
  type PasskeyStore,
} from './passkeys';

const cfg = rpConfig('https://b1dz.com');
const USER = '11111111-2222-4333-8444-555555555555';
const OTHER = '99999999-2222-4333-8444-555555555555';
const b64u = (b: Uint8Array | Buffer) => Buffer.from(b).toString('base64url');
const sha256 = (b: Uint8Array | Buffer | string) => createHash('sha256').update(b).digest();

function memoryStore(): PasskeyStore & { rows: Map<string, PasskeyRow>; challenges: Map<string, { challenge: string; purpose: ChallengePurpose; userId: string | null; exp: number }> } {
  const rows = new Map<string, PasskeyRow>();
  const challenges = new Map<string, { challenge: string; purpose: ChallengePurpose; userId: string | null; exp: number }>();
  return {
    rows,
    challenges,
    async saveChallenge({ challenge, purpose, userId }) {
      const id = crypto.randomUUID();
      challenges.set(id, { challenge, purpose, userId, exp: Date.now() + 300_000 });
      return id;
    },
    async takeChallenge(id, purpose) {
      const c = challenges.get(id);
      if (!c || c.purpose !== purpose || c.exp < Date.now()) return null;
      challenges.delete(id);
      return { challenge: c.challenge, userId: c.userId };
    },
    async byId(id) { return rows.get(id) ?? null; },
    async byUser(u) { return [...rows.values()].filter((r) => r.user_id === u); },
    async insert(row) { if (rows.has(row.id)) return 'conflict'; rows.set(row.id, { ...row }); return 'ok'; },
    async touch(id, counter) { const r = rows.get(id); if (r) { r.counter = counter; r.last_used_at = new Date().toISOString(); } },
    async remove(u, id) { const r = rows.get(id); if (!r || r.user_id !== u) return false; rows.delete(id); return true; },
    async rename(u, id, name) { const r = rows.get(id); if (!r || r.user_id !== u) return false; r.name = name; return true; },
  };
}

/** A minimal software authenticator: ES256, "none" attestation, UP+UV. */
class SoftAuthenticator {
  readonly credId = randomBytes(32);
  private readonly key: KeyObject;
  private readonly pub: { x: Buffer; y: Buffer };
  private counter = 0;
  userHandle = '';

  constructor(private readonly rpID = 'b1dz.com', private readonly origin = 'https://b1dz.com') {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    this.key = privateKey;
    const jwk = publicKey.export({ format: 'jwk' });
    this.pub = { x: Buffer.from(jwk.x!, 'base64url'), y: Buffer.from(jwk.y!, 'base64url') };
  }

  private authData(extra?: Buffer, uv = true): Buffer {
    const flags = 0x01 | (uv ? 0x04 : 0) | (extra ? 0x40 : 0);
    const count = Buffer.alloc(4);
    count.writeUInt32BE(this.counter);
    return Buffer.concat([sha256(this.rpID), Buffer.from([flags]), count, ...(extra ? [extra] : [])]);
  }

  create(options: { challenge: string; user: { id: string } }): RegistrationResponseJSON {
    this.userHandle = options.user.id;
    const cose = isoCBOR.encode(new Map<number, number | Uint8Array>([[1, 2], [3, -7], [-1, 1], [-2, this.pub.x], [-3, this.pub.y]]));
    const len = Buffer.alloc(2);
    len.writeUInt16BE(this.credId.length);
    const attested = Buffer.concat([Buffer.alloc(16), len, this.credId, Buffer.from(cose)]);
    const att = new Map<string, unknown>([['fmt', 'none'], ['attStmt', new Map()], ['authData', this.authData(attested)]]);
    const attestationObject = isoCBOR.encode(att as unknown as Parameters<typeof isoCBOR.encode>[0]);
    const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: options.challenge, origin: this.origin }));
    return {
      id: b64u(this.credId),
      rawId: b64u(this.credId),
      type: 'public-key',
      clientExtensionResults: {},
      response: { clientDataJSON: b64u(clientDataJSON), attestationObject: b64u(attestationObject), transports: ['internal'] },
    };
  }

  get(options: { challenge: string }, opts: { uv?: boolean; userHandle?: string } = {}): AuthenticationResponseJSON {
    this.counter += 1;
    const authenticatorData = this.authData(undefined, opts.uv ?? true);
    const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: options.challenge, origin: this.origin }));
    const signature = sign('sha256', Buffer.concat([authenticatorData, sha256(clientDataJSON)]), this.key);
    return {
      id: b64u(this.credId),
      rawId: b64u(this.credId),
      type: 'public-key',
      clientExtensionResults: {},
      response: {
        clientDataJSON: b64u(clientDataJSON),
        authenticatorData: b64u(authenticatorData),
        signature: b64u(signature),
        userHandle: opts.userHandle ?? this.userHandle,
      },
    };
  }
}

const user = { id: USER, email: 'a@example.com', displayName: 'a@example.com' };

async function register(store: ReturnType<typeof memoryStore>, auth = new SoftAuthenticator()) {
  const s = await startRegistration(cfg, user, store);
  if (!s.ok) throw new Error(s.error);
  const f = await finishRegistration(cfg, { userId: USER, challengeId: s.challengeId, response: auth.create(s.options), name: 'Laptop' }, store);
  return { auth, f, s };
}

describe('passkeys', () => {
  it('derives rpID and origin from the site URL', () => {
    expect(rpConfig('https://b1dz.com/')).toEqual({ rpID: 'b1dz.com', origin: 'https://b1dz.com' });
    expect(sameOrigin('https://b1dz.com', cfg)).toBe(true);
    expect(sameOrigin('https://evil.example', cfg)).toBe(false);
    expect(sameOrigin(null, cfg)).toBe(false);
  });

  it('registers a passkey and signs in with it', async () => {
    const store = memoryStore();
    const { auth, f, s } = await register(store);
    expect(f).toMatchObject({ ok: true, passkey: { name: 'Laptop' } });
    expect(s.ok && s.options.authenticatorSelection).toMatchObject({ residentKey: 'required', userVerification: 'required' });
    expect(store.rows.size).toBe(1);

    const l = await startLogin(cfg, store);
    const r = await finishLogin(cfg, { challengeId: l.challengeId, response: auth.get(l.options) }, store);
    expect(r).toEqual({ ok: true, userId: USER });
    expect(store.rows.get(b64u(auth.credId))!.counter).toBe(1);
  });

  it('a challenge works exactly once (replay is refused)', async () => {
    const store = memoryStore();
    const { auth } = await register(store);
    const l = await startLogin(cfg, store);
    const resp = auth.get(l.options);
    expect((await finishLogin(cfg, { challengeId: l.challengeId, response: resp }, store)).ok).toBe(true);
    expect(await finishLogin(cfg, { challengeId: l.challengeId, response: resp }, store)).toMatchObject({ ok: false });
  });

  it('refuses a register challenge used for login and vice versa', async () => {
    const store = memoryStore();
    const { auth } = await register(store);
    const s = await startRegistration(cfg, user, store);
    if (!s.ok) throw new Error('start');
    const r = await finishLogin(cfg, { challengeId: s.challengeId, response: auth.get({ challenge: s.options.challenge }) }, store);
    expect(r.ok).toBe(false);
  });

  it('refuses finishing registration as a different user than started it', async () => {
    const store = memoryStore();
    const s = await startRegistration(cfg, user, store);
    if (!s.ok) throw new Error('start');
    const f = await finishRegistration(cfg, { userId: OTHER, challengeId: s.challengeId, response: new SoftAuthenticator().create(s.options) }, store);
    expect(f.ok).toBe(false);
    expect(store.rows.size).toBe(0);
  });

  it('refuses a registration made for another origin', async () => {
    const store = memoryStore();
    const s = await startRegistration(cfg, user, store);
    if (!s.ok) throw new Error('start');
    const evil = new SoftAuthenticator('b1dz.com', 'https://evil.example');
    const f = await finishRegistration(cfg, { userId: USER, challengeId: s.challengeId, response: evil.create(s.options) }, store);
    expect(f.ok).toBe(false);
  });

  it('refuses an assertion without user verification', async () => {
    const store = memoryStore();
    const { auth } = await register(store);
    const l = await startLogin(cfg, store);
    expect((await finishLogin(cfg, { challengeId: l.challengeId, response: auth.get(l.options, { uv: false }) }, store)).ok).toBe(false);
  });

  it('refuses a userHandle that names another account', async () => {
    const store = memoryStore();
    const { auth } = await register(store);
    const l = await startLogin(cfg, store);
    const handle = b64u(new TextEncoder().encode(OTHER));
    expect((await finishLogin(cfg, { challengeId: l.challengeId, response: auth.get(l.options, { userHandle: handle }) }, store)).ok).toBe(false);
  });

  it('refuses an unknown credential and a forged signature', async () => {
    const store = memoryStore();
    await register(store);
    const stranger = new SoftAuthenticator();
    let l = await startLogin(cfg, store);
    expect((await finishLogin(cfg, { challengeId: l.challengeId, response: stranger.get(l.options) }, store)).ok).toBe(false);

    // Right credential id, wrong key.
    const { auth } = await register(store, new SoftAuthenticator());
    const forger = new SoftAuthenticator();
    l = await startLogin(cfg, store);
    const forged = forger.get(l.options, { userHandle: auth.userHandle });
    forged.id = forged.rawId = b64u(auth.credId);
    expect((await finishLogin(cfg, { challengeId: l.challengeId, response: forged }, store)).ok).toBe(false);
  });

  it('refuses the same credential twice and caps passkeys per user', async () => {
    const store = memoryStore();
    const { auth } = await register(store);
    const s = await startRegistration(cfg, user, store);
    if (!s.ok) throw new Error('start');
    expect(s.options.excludeCredentials?.[0]?.id).toBe(b64u(auth.credId));
    const again = await finishRegistration(cfg, { userId: USER, challengeId: s.challengeId, response: auth.create(s.options) }, store);
    expect(again).toMatchObject({ ok: false, error: expect.stringMatching(/already registered/) });

    for (let i = store.rows.size; i < MAX_PASSKEYS_PER_USER; i++) await register(store);
    expect(await startRegistration(cfg, user, store)).toMatchObject({ ok: false });
  });

  it('cleans passkey names', () => {
    expect(cleanName('  My\u0000 Phone ')).toBe('My Phone');
    expect(cleanName('')).toBe('Passkey');
    expect(cleanName(42)).toBe('Passkey');
    expect(cleanName('x'.repeat(100))).toHaveLength(60);
  });
});
