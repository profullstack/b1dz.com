import { describe, expect, it } from 'vitest';
import { request, type Server } from 'node:http';
import { UnlockStore } from './unlock-store.js';
import { startControlServer } from './control-server.js';

const U = '00000000-0000-4000-8000-0000000000aa';

function key(fill = 7) { return new Uint8Array(32).fill(fill); }

describe('UnlockStore', () => {
  it('unlock -> get -> lock zeroes the stored copy', () => {
    const s = new UnlockStore(Date.now, false);
    const k = key();
    s.unlock(U, k, 3600);
    const held = s.get(U)!;
    expect(held).not.toBe(k); // stored a copy
    expect([...held]).toEqual([...k]);
    s.lock(U);
    expect(s.get(U)).toBeNull();
    expect([...held].every((b) => b === 0)).toBe(true);
  });

  it('expires after the TTL', () => {
    let now = 1_000_000;
    const s = new UnlockStore(() => now, false);
    const st = s.unlock(U, key(), 120);
    expect(st.expiresAt).toBe(new Date(1_000_000 + 120_000).toISOString());
    now += 119_000;
    expect(s.get(U)).not.toBeNull();
    now += 2_000;
    expect(s.get(U)).toBeNull();
    expect(s.status(U)).toEqual({ unlocked: false, expiresAt: null });
  });

  it('clamps TTL: default 8h, max 7d, min 60s', () => {
    const now = 0;
    const s = new UnlockStore(() => now, false);
    expect(Date.parse(s.unlock(U, key(), 30 * 86400).expiresAt!)).toBe(7 * 86400 * 1000);
    expect(Date.parse(s.unlock(U, key(), 1).expiresAt!)).toBe(60 * 1000);
    expect(Date.parse(s.unlock(U, key()).expiresAt!)).toBe(8 * 3600 * 1000);
  });

  it('a new store (daemon restart) holds nothing', () => {
    const a = new UnlockStore(Date.now, false);
    a.unlock(U, key(), 3600);
    const restarted = new UnlockStore(Date.now, false);
    expect(restarted.get(U)).toBeNull();
    expect(restarted.size()).toBe(0);
  });

  it('rejects malformed keys and notifies listeners', () => {
    const s = new UnlockStore(Date.now, false);
    expect(() => s.unlock(U, new Uint8Array(16), 60)).toThrow();
    const events: boolean[] = [];
    s.onChange((_u, unlocked) => events.push(unlocked));
    s.unlock(U, key(), 60);
    s.lockAll();
    expect(events).toEqual([true, false]);
  });
});

function call(port: number, path: string, body: unknown, token?: string): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = request({ host: '127.0.0.1', port, path, method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { 'x-b1dz-control-token': token } : {}) } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c as Buffer));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString() || '{}') }));
    });
    req.on('error', reject);
    req.end(data);
  });
}

describe('control server', () => {
  const TOKEN = 'x'.repeat(40);

  it('does not start without a token (users stay locked)', () => {
    expect(startControlServer({ store: new UnlockStore(), verifyKey: async () => 'ok', token: '' })).toBeNull();
  });

  it('unlock / status / lock, with auth and key verification', async () => {
    const store = new UnlockStore(Date.now, false);
    const good = key(9);
    const server = startControlServer({
      store,
      token: TOKEN,
      port: 0,
      verifyKey: async (_u, k) => (k.every((b, i) => b === good[i]) ? 'ok' : 'bad-key'),
    }) as Server;
    await new Promise((r) => server.once('listening', r));
    const port = (server.address() as { port: number }).port;
    try {
      const b64 = Buffer.from(good).toString('base64');
      expect((await call(port, '/unlock', { userId: U, dataKey: b64 })).status).toBe(401);
      expect((await call(port, '/unlock', { userId: U, dataKey: b64 }, 'y'.repeat(40))).status).toBe(401);
      expect((await call(port, '/unlock', { userId: U, dataKey: Buffer.from(key(1)).toString('base64') }, TOKEN)).status).toBe(403);
      expect((await call(port, '/unlock', { userId: 'nope', dataKey: b64 }, TOKEN)).status).toBe(400);
      const ok = await call(port, '/unlock', { userId: U, dataKey: b64, ttlSeconds: 600 }, TOKEN);
      expect(ok.status).toBe(200);
      expect(ok.body.unlocked).toBe(true);
      expect(JSON.stringify(ok.body)).not.toContain(b64);
      expect((await call(port, '/status', { userId: U }, TOKEN)).body.unlocked).toBe(true);
      expect((await call(port, '/lock', { userId: U }, TOKEN)).body.unlocked).toBe(false);
      expect(store.get(U)).toBeNull();
    } finally {
      server.close();
    }
  });
});
