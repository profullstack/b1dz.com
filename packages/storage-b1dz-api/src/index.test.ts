import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runStorageContractTests } from '@b1dz/core/storage-contract';
import { B1dzApiStorage } from './index.js';

function makeJwt(expOffsetSec: number) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ exp: now + expOffsetSec })).toString('base64url');
  return `${header}.${payload}.sig`;
}

function parseBody(input: RequestInit | undefined) {
  if (!input?.body || typeof input.body !== 'string') return null;
  try {
    return JSON.parse(input.body);
  } catch {
    return null;
  }
}

function installApiMock() {
  const store = new Map<string, Map<string, unknown>>();
  let accessToken = makeJwt(3600);
  let refreshToken = 'refresh-ok';
  let refreshCalls = 0;
  let force401Once = false;

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const parsed = new URL(url);
    const path = parsed.pathname;
    const method = init?.method ?? 'GET';

    if (path === '/api/auth/refresh' && method === 'POST') {
      refreshCalls += 1;
      const body = parseBody(init);
      if (body?.refresh_token !== refreshToken) {
        return new Response(JSON.stringify({ error: 'bad refresh token' }), { status: 401 });
      }
      accessToken = makeJwt(3600);
      refreshToken = `refresh-${refreshCalls}`;
      return new Response(JSON.stringify({
        session: {
          access_token: accessToken,
          refresh_token: refreshToken,
        },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json', 'x-b1dz-version': 'test-api' },
      });
    }

    const authHeader = (init?.headers as Record<string, string> | undefined)?.authorization ?? '';
    const token = authHeader.replace(/^Bearer\s+/i, '');
    if (!token || token !== accessToken || force401Once) {
      force401Once = false;
      return new Response(JSON.stringify({ error: 'unauthorized' }), {
        status: 401,
        headers: { 'content-type': 'application/json', 'x-b1dz-version': 'test-api' },
      });
    }

    const parts = path.split('/').filter(Boolean);
    if (parts[0] !== 'api' || parts[1] !== 'storage') {
      return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
    }

    const collection = decodeURIComponent(parts[2] ?? '');
    const collectionStore = store.get(collection) ?? new Map<string, unknown>();
    store.set(collection, collectionStore);

    if (parts.length === 3 && method === 'GET') {
      return new Response(JSON.stringify({ items: [...collectionStore.values()] }), {
        status: 200,
        headers: { 'content-type': 'application/json', 'x-b1dz-version': 'test-api' },
      });
    }

    const key = decodeURIComponent(parts[3] ?? '');
    if (!key) {
      return new Response(JSON.stringify({ error: 'missing key' }), { status: 400 });
    }

    if (method === 'GET') {
      return new Response(JSON.stringify({ value: collectionStore.get(key) ?? null }), {
        status: 200,
        headers: { 'content-type': 'application/json', 'x-b1dz-version': 'test-api' },
      });
    }
    if (method === 'PUT') {
      collectionStore.set(key, parseBody(init));
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json', 'x-b1dz-version': 'test-api' },
      });
    }
    if (method === 'DELETE') {
      collectionStore.delete(key);
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json', 'x-b1dz-version': 'test-api' },
      });
    }

    return new Response(JSON.stringify({ error: 'unsupported' }), { status: 405 });
  });

  vi.stubGlobal('fetch', fetchMock);

  return {
    makeStorage() {
      return new B1dzApiStorage({
        baseUrl: 'https://b1dz.test',
        tokens: {
          accessToken,
          refreshToken,
        },
        onRefresh(tokens) {
          accessToken = tokens.accessToken;
          refreshToken = tokens.refreshToken;
        },
      });
    },
    getRefreshCalls() {
      return refreshCalls;
    },
    forceUnauthorizedOnce() {
      force401Once = true;
    },
    setExpiredAccessToken() {
      accessToken = makeJwt(-60);
    },
    seed(collection: string, key: string, value: unknown) {
      const collectionStore = store.get(collection) ?? new Map<string, unknown>();
      collectionStore.set(key, value);
      store.set(collection, collectionStore);
    },
    fetchMock,
  };
}

let api = installApiMock();

beforeEach(() => {
  api = installApiMock();
});

runStorageContractTests('B1dzApiStorage', async () => api.makeStorage());

describe('B1dzApiStorage API contract', () => {
  it('proactively refreshes an expired access token before storage requests', async () => {
    api.setExpiredAccessToken();
    const storage = api.makeStorage();
    await storage.get('source-state', 'crypto-trade');
    expect(api.getRefreshCalls()).toBe(1);
  });

  it('retries once after a 401 by refreshing tokens', async () => {
    const storage = api.makeStorage();
    api.forceUnauthorizedOnce();
    await storage.put('source-state', 'crypto-trade', { daemon: { version: '0.3.4' } });
    expect(api.getRefreshCalls()).toBe(1);
    expect(await storage.get<{ daemon: { version: string } }>('source-state', 'crypto-trade')).toEqual({
      daemon: { version: '0.3.4' },
    });
  });

  it('preserves live source-state payloads from the API contract', async () => {
    api.seed('source-state', 'crypto-trade', {
      daemon: { worker: 'crypto-trade', version: '0.3.4', status: 'running' },
      tradeStatus: { eligiblePairs: 73, observedPairs: 73, dailyLossLimitHit: false },
      activityLog: [{ at: '2026-04-14T00:00:00.000Z', text: 'alive' }],
    });
    const storage = api.makeStorage();
    await expect(storage.get('source-state', 'crypto-trade')).resolves.toEqual({
      daemon: { worker: 'crypto-trade', version: '0.3.4', status: 'running' },
      tradeStatus: { eligiblePairs: 73, observedPairs: 73, dailyLossLimitHit: false },
      activityLog: [{ at: '2026-04-14T00:00:00.000Z', text: 'alive' }],
    });
  });
});
