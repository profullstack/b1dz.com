/**
 * /api/settings + /api/settings/legacy-migrate: the migration path and the
 * rules that keep legacy server-key ciphertext from being re-written.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCipheriv, createHmac, randomBytes } from 'node:crypto';
import { createSeal, sealSecrets, unsealSecrets, type SealRecord } from '@b1dz/core/sealed-secrets';

const USER = '00000000-0000-4000-8000-0000000000bb';
let row: Record<string, unknown> | null = null;

const client = {
  from: () => ({
    select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: row ? structuredClone(row) : null, error: null }) }) }),
    upsert: async (r: Record<string, unknown>) => {
      row = { ...(row ?? {}), ...r };
      return { error: null };
    },
  }),
};

vi.mock('@/lib/api-auth', () => ({
  authenticate: async () => ({ client, userId: USER, email: null }),
  unauthorized: () => Response.json({ error: 'unauthorized' }, { status: 401 }),
}));

const { GET, PUT } = await import('./route');
const { POST: MIGRATE } = await import('./legacy-migrate/route');

const req = (body?: unknown) => ({ json: async () => body }) as never;

let master: Buffer;
let created: { dek: Uint8Array; seal: SealRecord };
const saved = { ...process.env };

beforeAll(async () => {
  const c = await createSeal('migration passphrase', USER);
  created = { dek: c.dek, seal: c.seal };
});

function legacyRow(secret: Record<string, string>) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', createHmac('sha256', master).update(USER).digest(), iv);
  const ct = Buffer.concat([c.update(JSON.stringify(secret), 'utf8'), c.final()]);
  return {
    user_id: USER,
    payload_plain: {},
    payload_secret_ciphertext: ct.toString('base64'),
    payload_secret_iv: iv.toString('base64'),
    payload_secret_tag: c.getAuthTag().toString('base64'),
    seal_version: 1,
    seal: null,
    secret_inbox: [],
    updated_at: new Date().toISOString(),
  };
}

beforeEach(() => {
  master = randomBytes(32);
  process.env.SETTINGS_ENCRYPTION_KEY = master.toString('base64');
  delete process.env.LEGACY_KEY_MIGRATION;
  row = null;
});
afterEach(() => { process.env = { ...saved }; });

describe('legacy migration', () => {
  it('GET never hands out legacy ciphertext; reports it as pending', async () => {
    row = legacyRow({ SOLANA_PRIVATE_KEY: 'sol' });
    const body = await (await GET(req())).json();
    expect(body.cipher).toBeNull();
    expect(body.seal).toBeNull();
    expect(body.legacy).toEqual({ pending: true, migrationOpen: true });
  });

  it('migrate -> re-seal -> PUT overwrites the legacy columns and marks v2', async () => {
    row = legacyRow({ SOLANA_PRIVATE_KEY: 'sol', KRAKEN_API_SECRET: 'kr' });
    const legacyCt = row.payload_secret_ciphertext;
    const m = await MIGRATE(req());
    expect(m.status).toBe(200);
    const { secret } = await m.json();
    expect(secret).toEqual({ SOLANA_PRIVATE_KEY: 'sol', KRAKEN_API_SECRET: 'kr' });

    const cipher = await sealSecrets(created.dek, secret, USER);
    const res = await PUT(req({ seal: created.seal, cipher }));
    expect(res.status).toBe(200);
    expect(row!.seal_version).toBe(2);
    expect(row!.payload_secret_ciphertext).not.toBe(legacyCt);
    const back = await unsealSecrets(created.dek, {
      ciphertext: row!.payload_secret_ciphertext as string, iv: row!.payload_secret_iv as string, tag: row!.payload_secret_tag as string,
    }, USER);
    expect(back).toEqual(secret);

    // one-shot: a sealed row cannot be "migrated" again
    expect((await MIGRATE(req())).status).toBe(409);
  });

  it('a seal alone cannot relabel legacy ciphertext as v2', async () => {
    row = legacyRow({ A: '1' });
    expect((await PUT(req({ seal: created.seal }))).status).toBe(409);
    expect(row!.seal_version).toBe(1);
  });

  it('cipher writes need a passphrase (no new server-key or unsealed rows)', async () => {
    row = legacyRow({ A: '1' });
    const cipher = await sealSecrets(created.dek, { A: '2' }, USER);
    expect((await PUT(req({ cipher }))).status).toBe(409);
  });

  it('LEGACY_KEY_MIGRATION=off closes the migrate path (410)', async () => {
    row = legacyRow({ A: '1' });
    process.env.LEGACY_KEY_MIGRATION = 'off';
    expect((await MIGRATE(req())).status).toBe(410);
    const body = await (await GET(req())).json();
    expect(body.legacy).toEqual({ pending: true, migrationOpen: false });
  });

  it('rejects a weak seal record', async () => {
    const weak = { ...created.seal, kdf: { ...created.seal.kdf, iterations: 1000 } };
    expect((await PUT(req({ seal: weak }))).status).toBe(400);
  });
});
