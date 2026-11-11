import { createHmac } from 'node:crypto';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createSealer } from '@profullstack/sealed-secrets';
import { createSeal, openInbox, sealToInbox, type InboxEntry, type SealRecord } from '@b1dz/core/sealed-secrets';

// ---- a tiny in-memory stand-in for the supabase-js calls the module makes ----
type Row = Record<string, unknown>;
const KEYS: Record<string, string> = { kg_grant_requests: 'nonce', kg_grants: 'grant_id', user_settings: 'user_id' };

function fakeDb() {
  const tables: Record<string, Map<string, Row>> = { kg_grant_requests: new Map(), kg_grants: new Map(), user_settings: new Map() };
  const from = (t: string) => {
    const tbl = tables[t];
    const pk = KEYS[t];
    let filters: [string, unknown][] = [];
    let orderBy: string | null = null;
    let lim = Infinity;
    const rows = () => {
      let r = [...tbl.values()].filter((row) => filters.every(([c, v]) => row[c] === v));
      if (orderBy) r = r.sort((a, b) => Number(b[orderBy!]) - Number(a[orderBy!]));
      return r.slice(0, lim).map((x) => structuredClone(x));
    };
    const q = {
      select: () => q,
      eq: (c: string, v: unknown) => { filters.push([c, v]); return q; },
      order: (c: string) => { orderBy = c; return q; },
      limit: (n: number) => { lim = n; return q; },
      maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
      then: (res: (v: unknown) => void) => res({ data: rows(), error: null }),
      insert: async (row: Row) => {
        if (tbl.has(String(row[pk]))) return { error: { message: 'duplicate' } };
        tbl.set(String(row[pk]), structuredClone(row));
        return { error: null };
      },
      upsert: async (row: Row) => {
        tbl.set(String(row[pk]), { ...(tbl.get(String(row[pk])) ?? {}), ...structuredClone(row) });
        return { error: null };
      },
    };
    filters = [];
    return q;
  };
  return { from, tables };
}

let db = fakeDb();
vi.mock('@/lib/supabase', () => ({ createAdminSupabase: () => ({ from: (t: string) => db.from(t) }) }));
let authed: { userId: string } | null = null;
vi.mock('@/lib/api-auth', () => ({ authenticate: async () => authed }));

const { b1dzKeyGrants, parseSealedEntry } = await import('./logicsrc-grants');

const USER = '6f1d2c3b-4a59-4e6f-8a7b-9c0d1e2f3a4b';
const ORIGIN = 'https://b1dz.test';
const npmSealer = createSealer({ app: 'b1dz', scope: 'user_settings' });

function sign(secret: string, body: string, id = 'msg_1', ts = Math.floor(Date.now() / 1000)) {
  const sig = createHmac('sha256', Buffer.from(secret, 'utf8')).update(`${id}.${ts}.${body}`).digest('base64');
  return { 'webhook-id': id, 'webhook-timestamp': String(ts), 'webhook-signature': `v1,${sig}` };
}

async function withVault() {
  const made = await createSeal('a long enough passphrase', USER);
  db.tables.user_settings.set(USER, { user_id: USER, seal_version: 2, seal: made.seal, secret_inbox: [] });
  return made;
}
const inbox = () => (db.tables.user_settings.get(USER)!.secret_inbox as InboxEntry[]);

beforeEach(() => {
  db = fakeDb();
  authed = null;
});

describe('sealing compatibility', () => {
  it('@profullstack/sealed-secrets (b1dz, user_settings) and @b1dz/core seal to each other', async () => {
    const { dek, seal } = await createSeal('a long enough passphrase', USER);
    const fromNpm = await npmSealer.sealToInbox(seal.inbox_public_key, { ANTHROPIC_API_KEY: 'sk-ant-from-npm' }, USER);
    expect((await openInbox(dek, seal, [fromNpm], USER)).patch).toEqual({ ANTHROPIC_API_KEY: 'sk-ant-from-npm' });

    const fromCore = await sealToInbox(seal.inbox_public_key, { OPENAI_API_KEY: 'sk-from-core' }, USER);
    expect((await npmSealer.openInbox(dek, seal, [fromCore], USER)).patch).toEqual({ OPENAI_API_KEY: 'sk-from-core' });

    // A different app or scope does not open.
    const other = await createSealer({ app: 'meshhook', scope: 'user_settings' }).sealToInbox(seal.inbox_public_key, { X: 'y' }, USER);
    expect((await openInbox(dek, seal, [other], USER)).consumed).toEqual([]);
  }, 60_000);
});

describe('b1dz key grants', () => {
  const kg = () => b1dzKeyGrants({ db, origin: ORIGIN });

  it('start needs a vault; the manifest names the vault inbox and the webhook', async () => {
    await expect(kg().start({ userId: USER, keys: 'ANTHROPIC_API_KEY' })).rejects.toMatchObject({ code: 'needs_vault' });
    const { seal } = await withVault();

    const to = new URL(await kg().start({ userId: USER, keys: 'ANTHROPIC_API_KEY,OPENAI_API_KEY', next: '/settings' }));
    expect(to.origin + to.pathname).toBe('https://app.logicsrc.com/grant');
    expect(to.searchParams.get('origin')).toBe(ORIGIN);
    const nonce = to.searchParams.get('nonce')!;

    const res = await kg().manifestResponse(nonce);
    expect(res.status).toBe(200);
    const m = await res.json();
    expect(m).toMatchObject({
      v: 1,
      app_name: 'b1dz',
      keys: [{ name: 'ANTHROPIC_API_KEY' }, { name: 'OPENAI_API_KEY' }],
      recipient: { format: 'sealed-secrets/inbox-v2', app: 'b1dz', scope: 'user_settings', user_id: USER, inbox_public_key: (seal as SealRecord).inbox_public_key },
      webhook_url: `${ORIGIN}/api/v1/logicsrc/webhook`,
      return_url: `${ORIGIN}/settings?logicsrc=granted`,
    });
    expect(typeof m.webhook_secret).toBe('string');

    const missing = await kg().manifestResponse('unknownnonce123456789');
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'unknown or expired request' });
  }, 60_000);

  it('a signed delivery queues the sealed key in the vault inbox; rotation replaces it; revoke blanks it', async () => {
    const { dek, seal } = await withVault();
    const nonce = new URL(await kg().start({ userId: USER, keys: 'ANTHROPIC_API_KEY' })).searchParams.get('nonce')!;
    const m = (await kg().manifest(nonce))!;
    const deliver = async (type: string, value?: string, extra: Record<string, string> = {}) => {
      const sealed = value === undefined ? undefined
        : `sealed:v2:${JSON.stringify(await npmSealer.sealToInbox(m.recipient.inbox_public_key, { ANTHROPIC_API_KEY: value, ...extra }, USER))}`;
      const body = JSON.stringify({ type, grant_id: 'g_1', key_name: 'ANTHROPIC_API_KEY', recipient_user_id: USER, sealed });
      return kg().webhook(sign(m.webhook_secret, body, `msg_${type}_${value}`), body);
    };

    // Unsigned or wrongly signed: refused, nothing queued.
    const body = JSON.stringify({ type: 'grant.delivered', grant_id: 'g_1', key_name: 'ANTHROPIC_API_KEY', recipient_user_id: USER, sealed: 'sealed:v2:{}' });
    expect((await kg().webhook({}, body)).status).toBe(401);
    expect((await kg().webhook(sign('not-the-secret', body), body)).status).toBe(401);
    expect(inbox()).toEqual([]);

    // Delivered (with a smuggled extra key, which the entry's allowlist drops on open).
    expect(await deliver('grant.delivered', 'sk-ant-one', { EVM_PRIVATE_KEY: '0xattacker' })).toEqual({ status: 200, body: { ok: true, key: 'ANTHROPIC_API_KEY' } });
    expect(inbox()).toHaveLength(1);
    expect(inbox()[0]).toMatchObject({ keys: ['ANTHROPIC_API_KEY'], source: 'logicsrc' });
    expect(JSON.stringify(inbox())).not.toContain('sk-ant-one');
    expect((await openInbox(dek, seal, inbox(), USER)).patch).toEqual({ ANTHROPIC_API_KEY: 'sk-ant-one' });

    // Rotation: the queued older value is replaced, not stacked.
    expect((await deliver('grant.updated', 'sk-ant-two')).status).toBe(200);
    expect(inbox()).toHaveLength(1);
    expect((await openInbox(dek, seal, inbox(), USER)).patch).toEqual({ ANTHROPIC_API_KEY: 'sk-ant-two' });
    expect(db.tables.kg_grants.get('g_1')).toMatchObject({ status: 'active', key_name: 'ANTHROPIC_API_KEY', user_id: USER });

    // Revoke: the pending value is dropped and a sealed blank queued, so the next unlock clears it.
    expect((await deliver('grant.revoked')).status).toBe(200);
    expect(inbox()).toHaveLength(1);
    expect((await openInbox(dek, seal, inbox(), USER)).patch).toEqual({ ANTHROPIC_API_KEY: '' });
    expect(db.tables.kg_grants.get('g_1')).toMatchObject({ status: 'revoked' });
  }, 60_000);

  it('a delivery for a key the request did not name is refused', async () => {
    await withVault();
    const nonce = new URL(await kg().start({ userId: USER, keys: 'ANTHROPIC_API_KEY' })).searchParams.get('nonce')!;
    const m = (await kg().manifest(nonce))!;
    const sealed = `sealed:v2:${JSON.stringify(await npmSealer.sealToInbox(m.recipient.inbox_public_key, { OPENAI_API_KEY: 'x' }, USER))}`;
    const body = JSON.stringify({ type: 'grant.delivered', grant_id: 'g_2', key_name: 'OPENAI_API_KEY', recipient_user_id: USER, sealed });
    expect((await kg().webhook(sign(m.webhook_secret, body), body)).status).toBe(400);
    expect(inbox()).toEqual([]);
  }, 60_000);

  it('parseSealedEntry accepts only sealed:v2 inbox entries and strips extra fields', async () => {
    const { seal } = await createSeal('a long enough passphrase', USER);
    const e = await npmSealer.sealToInbox(seal.inbox_public_key, { A: 'b' }, USER);
    expect(parseSealedEntry(`sealed:v2:${JSON.stringify({ ...e, keys: ['EVM_PRIVATE_KEY'] })}`)).toEqual(e);
    expect(parseSealedEntry('sealed:v2:{"id":1}')).toBeNull();
    expect(parseSealedEntry(JSON.stringify(e))).toBeNull();
  }, 30_000);
});

describe('GET /api/v1/logicsrc/grant/start', () => {
  const call = async (qs: string) => {
    const { GET } = await import('@/app/api/v1/logicsrc/grant/start/route');
    const { NextRequest } = await import('next/server');
    return GET(new NextRequest(`https://b1dz.com/api/v1/logicsrc/grant/start?${qs}`));
  };

  it('sends a signed-out person to login', async () => {
    const res = await call('keys=ANTHROPIC_API_KEY');
    expect(res.status).toBe(303);
    expect(new URL(res.headers.get('location')!).pathname).toBe('/login');
  });

  it('never asks for signing keys', async () => {
    authed = { userId: USER };
    for (const k of ['EVM_PRIVATE_KEY', 'SOLANA_PRIVATE_KEY', 'X402_PRIVATE_KEY', 'COINBASE_API_PRIVATE_KEY', 'NOT_A_B1DZ_KEY']) {
      const res = await call(`keys=ANTHROPIC_API_KEY,${k}`);
      expect(res.headers.get('location')).toBe('/settings?logicsrc=bad_key');
    }
    expect(db.tables.kg_grant_requests.size).toBe(0);
  });

  it('signed in with a vault: 303 to logicsrc', async () => {
    authed = { userId: USER };
    await withVault();
    const res = await call('keys=ANTHROPIC_API_KEY&next=/settings');
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toMatch(/^https:\/\/app\.logicsrc\.com\/grant\?origin=/);
    expect(db.tables.kg_grant_requests.size).toBe(1);
  }, 30_000);
});
