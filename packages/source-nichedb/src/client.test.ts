import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNichedbClient, NichedbError, type FetchLike } from './client.js';
import { nichedbBaseUrl, nichedbEnabled } from './env.js';

type Call = { url: string; init?: Parameters<FetchLike>[1] };

function fakeFetch(handler: (url: URL, call: Call) => { status?: number; body: unknown } | Promise<{ status?: number; body: unknown }>) {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    const call = { url, init };
    calls.push(call);
    const { status = 200, body } = await handler(new URL(url), call);
    return { ok: status >= 200 && status < 300, status, statusText: status === 200 ? 'OK' : 'ERR', json: async () => body };
  };
  return { fetch, calls };
}

const row = (id: number, extra: Record<string, unknown> = {}) => ({
  id, collection: 'crypto', kind: 'pair', external_id: `x:${id}`, title: `#${id}`, published_at: null, updated_at: '2026-09-11T00:00:00Z', tags: [], data: {}, ...extra,
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('createNichedbClient', () => {
  it('builds the items URL from the query with a comma tag list and a capped limit', () => {
    const client = createNichedbClient({ baseUrl: 'https://example.test/', fetch: fakeFetch(() => ({ body: { items: [] } })).fetch });
    const url = new URL(client.itemsUrl({ collection: 'crypto', kind: 'pair', tags: ['stable-quote', 'venue:kraken'], limit: 2500, since: '2026-09-11T00:00:00Z', after: 12 }));
    expect(url.origin + url.pathname).toBe('https://example.test/api/v1/items');
    expect(url.searchParams.get('collection')).toBe('crypto');
    expect(url.searchParams.get('kind')).toBe('pair');
    expect(url.searchParams.get('tags')).toBe('stable-quote,venue:kraken');
    expect(url.searchParams.get('limit')).toBe('200');
    expect(url.searchParams.get('since')).toBe('2026-09-11T00:00:00Z');
    expect(url.searchParams.get('after')).toBe('12');
  });

  it('defaults the base to NICHEDB_URL, else nichedb.dev', () => {
    expect(nichedbBaseUrl({})).toBe('https://nichedb.dev');
    expect(nichedbBaseUrl({ NICHEDB_URL: 'http://localhost:3000/' })).toBe('http://localhost:3000');
    vi.stubEnv('NICHEDB_URL', 'https://mirror.test');
    expect(createNichedbClient({ fetch: fakeFetch(() => ({ body: { items: [] } })).fetch }).baseUrl).toBe('https://mirror.test');
  });

  it('walks after= keyset pages of 200 in id order and stops on a short page', async () => {
    const total = 450;
    const all = Array.from({ length: total }, (_, i) => row(i + 1));
    const { fetch, calls } = fakeFetch((url) => {
      const after = Number(url.searchParams.get('after') ?? 0);
      const limit = Number(url.searchParams.get('limit'));
      expect(url.searchParams.get('sort')).toBe('id');
      expect(url.searchParams.get('order')).toBe('asc');
      const page = all.filter((r) => r.id > after).slice(0, limit);
      return { body: { count: page.length, items: page } };
    });
    const client = createNichedbClient({ baseUrl: 'https://n.test', fetch });
    const items = await client.walk({ collection: 'crypto', kind: 'pair', tags: ['stable-quote'] });
    expect(items).toHaveLength(total);
    expect(items.map((i) => i.id)).toEqual(all.map((r) => r.id));
    expect(calls).toHaveLength(3); // 200 + 200 + 50
    expect(new URL(calls[1]!.url).searchParams.get('after')).toBe('200');
    expect(new URL(calls[2]!.url).searchParams.get('after')).toBe('400');
    expect(client.requestCount).toBe(3);
  });

  it('makes one extra request when the last page is exactly full', async () => {
    const all = Array.from({ length: 400 }, (_, i) => row(i + 1));
    const { fetch, calls } = fakeFetch((url) => {
      const after = Number(url.searchParams.get('after') ?? 0);
      return { body: { items: all.filter((r) => r.id > after).slice(0, 200) } };
    });
    const items = await createNichedbClient({ baseUrl: 'https://n.test', fetch }).walk({ collection: 'crypto' });
    expect(items).toHaveLength(400);
    expect(calls).toHaveLength(3);
  });

  it('honours maxItems and maxPages', async () => {
    const all = Array.from({ length: 1000 }, (_, i) => row(i + 1));
    const { fetch, calls } = fakeFetch((url) => {
      const after = Number(url.searchParams.get('after') ?? 0);
      return { body: { items: all.filter((r) => r.id > after).slice(0, 200) } };
    });
    const client = createNichedbClient({ baseUrl: 'https://n.test', fetch });
    expect(await client.walk({ collection: 'crypto', kind: 'asset' }, { maxItems: 500 })).toHaveLength(500);
    expect(calls).toHaveLength(3);
    calls.length = 0;
    expect(await client.walk({ collection: 'crypto', kind: 'asset' }, { maxPages: 2 })).toHaveLength(400);
    expect(calls).toHaveLength(2);
  });

  it('passes since= through on every page', async () => {
    const { fetch, calls } = fakeFetch(() => ({ body: { items: [] } }));
    await createNichedbClient({ baseUrl: 'https://n.test', fetch }).walk({ collection: 'crypto', since: new Date('2026-09-11T05:00:00Z') });
    expect(new URL(calls[0]!.url).searchParams.get('since')).toBe('2026-09-11T05:00:00.000Z');
  });

  it('throws a NichedbError on a non-2xx answer, an error body, or a malformed body', async () => {
    const c1 = createNichedbClient({ baseUrl: 'https://n.test', fetch: fakeFetch(() => ({ status: 503, body: {} })).fetch });
    await expect(c1.items({ collection: 'crypto' })).rejects.toBeInstanceOf(NichedbError);
    const c2 = createNichedbClient({ baseUrl: 'https://n.test', fetch: fakeFetch(() => ({ body: { error: 'No collection named crypto' } })).fetch });
    await expect(c2.items({ collection: 'crypto' })).rejects.toThrow(/No collection named crypto/);
    const c3 = createNichedbClient({ baseUrl: 'https://n.test', fetch: fakeFetch(() => ({ body: { nope: true } })).fetch });
    await expect(c3.items({ collection: 'crypto' })).rejects.toThrow(/malformed/);
  });

  it('aborts a request that exceeds the timeout', async () => {
    vi.useFakeTimers();
    try {
      const fetch: FetchLike = (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        });
      const client = createNichedbClient({ baseUrl: 'https://n.test', fetch, timeoutMs: 50 });
      const p = client.items({ collection: 'crypto' });
      const assertion = expect(p).rejects.toThrow(/timeout after 50ms/);
      await vi.advanceTimersByTimeAsync(60);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('nichedbEnabled', () => {
  it('is on for 1/true/yes/on and off otherwise', () => {
    for (const v of ['1', 'true', 'TRUE', 'yes', ' on ']) expect(nichedbEnabled('NICHEDB_CRYPTO', { NICHEDB_CRYPTO: v })).toBe(true);
    for (const v of ['0', 'false', '', 'no']) expect(nichedbEnabled('NICHEDB_CRYPTO', { NICHEDB_CRYPTO: v })).toBe(false);
    expect(nichedbEnabled('NICHEDB_MARKETS', {})).toBe(false);
  });
});
