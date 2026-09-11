/**
 * Tiny client for nichedb.dev's public, keyless items API.
 *
 *   GET /api/v1/items?collection=&kind=&tags=a,b&since=&sort=&order=&limit=&after=
 *
 * The API caps `limit` at 200 and answers `{ count, items }` with no cursor,
 * so a full read walks keyset pages: `sort=id&order=asc&after=<last id>` until
 * a page comes back short. About 600 requests an hour per IP are tolerated;
 * callers are expected to cache.
 */

import { nichedbBaseUrl } from './env.js';

/** One row of `/api/v1/items`; `data` is the adapter's full record. */
export interface NichedbItem<T = unknown> {
  id: number;
  collection: string;
  source?: string;
  adapter?: string;
  kind: string;
  external_id: string;
  title: string;
  summary?: string | null;
  url?: string | null;
  image_url?: string | null;
  published_at: string | null;
  updated_at: string;
  tags: string[];
  data: T;
}

export interface ItemsQuery {
  collection: string;
  kind?: string;
  /** All named tags must be on the item (comma list on the wire). */
  tags?: string[];
  /** Only rows whose `updated_at` is at or after this stamp. */
  since?: string | Date;
  sort?: 'id' | 'published' | 'updated';
  order?: 'asc' | 'desc';
  /** Page size, capped by the API at 200. */
  limit?: number;
  /** Keyset cursor: rows with `id` greater than this. */
  after?: number;
}

/** The slice of fetch the client needs, so tests and proxies can hand in their own. */
export type FetchLike = (
  input: string,
  init?: { signal?: AbortSignal; headers?: Record<string, string> },
) => Promise<{ ok: boolean; status: number; statusText: string; json(): Promise<unknown> }>;

export interface NichedbClientOptions {
  /** Base URL; defaults to NICHEDB_URL or https://nichedb.dev. */
  baseUrl?: string;
  /** Injectable fetch (tests, proxies). Defaults to globalThis.fetch. */
  fetch?: FetchLike;
  /** Per-request timeout. */
  timeoutMs?: number;
  /** Sent as User-Agent so nichedb can see who is reading. */
  userAgent?: string;
}

export interface WalkOptions {
  /** Hard stop on the number of pages, so a bug upstream cannot loop forever. */
  maxPages?: number;
  /** Stop once this many rows have been collected. */
  maxItems?: number;
}

export const NICHEDB_PAGE_LIMIT = 200;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_PAGES = 25;

export class NichedbError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly url?: string,
  ) {
    super(message);
    this.name = 'NichedbError';
  }
}

export interface NichedbClient {
  readonly baseUrl: string;
  /** Build the items URL for a query (exposed for logging and tests). */
  itemsUrl(query: ItemsQuery): string;
  /** One page of items. */
  items<T = unknown>(query: ItemsQuery): Promise<NichedbItem<T>[]>;
  /** Every item matching the query, walking `after=` keyset pages in id order. */
  walk<T = unknown>(query: ItemsQuery, opts?: WalkOptions): Promise<NichedbItem<T>[]>;
  /** Requests made so far by this client (for budget checks and tests). */
  readonly requestCount: number;
}

export function createNichedbClient(opts: NichedbClientOptions = {}): NichedbClient {
  const baseUrl = (opts.baseUrl ?? nichedbBaseUrl()).replace(/\/+$/, '');
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const userAgent = opts.userAgent ?? 'b1dz (+https://b1dz.com)';
  let requestCount = 0;

  const resolveFetch = (): FetchLike => {
    const f = opts.fetch ?? (globalThis.fetch as unknown as FetchLike | undefined);
    if (!f) throw new NichedbError('no fetch available');
    return f;
  };

  function itemsUrl(query: ItemsQuery): string {
    const params = new URLSearchParams();
    params.set('collection', query.collection);
    if (query.kind) params.set('kind', query.kind);
    if (query.tags && query.tags.length > 0) params.set('tags', query.tags.join(','));
    if (query.since != null) {
      params.set('since', query.since instanceof Date ? query.since.toISOString() : query.since);
    }
    if (query.sort) params.set('sort', query.sort);
    if (query.order) params.set('order', query.order);
    if (query.limit != null) params.set('limit', String(Math.min(Math.max(1, query.limit), NICHEDB_PAGE_LIMIT)));
    if (query.after != null) params.set('after', String(query.after));
    return `${baseUrl}/api/v1/items?${params.toString()}`;
  }

  async function items<T>(query: ItemsQuery): Promise<NichedbItem<T>[]> {
    const url = itemsUrl(query);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    requestCount++;
    try {
      const res = await resolveFetch()(url, {
        signal: controller.signal,
        headers: { Accept: 'application/json', 'User-Agent': userAgent },
      });
      if (!res.ok) throw new NichedbError(`nichedb ${res.status} ${res.statusText}`, res.status, url);
      const body = (await res.json()) as { count?: number; items?: unknown; error?: string } | null;
      if (body && typeof body.error === 'string') throw new NichedbError(`nichedb: ${body.error}`, res.status, url);
      if (!body || !Array.isArray(body.items)) {
        throw new NichedbError('nichedb: malformed answer (no items array)', res.status, url);
      }
      return body.items as NichedbItem<T>[];
    } catch (e) {
      if ((e as Error).name === 'AbortError') throw new NichedbError(`nichedb: timeout after ${timeoutMs}ms`, undefined, url);
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  async function walk<T>(query: ItemsQuery, walkOpts: WalkOptions = {}): Promise<NichedbItem<T>[]> {
    const maxPages = walkOpts.maxPages ?? DEFAULT_MAX_PAGES;
    const maxItems = walkOpts.maxItems ?? Number.POSITIVE_INFINITY;
    const pageSize = Math.min(query.limit ?? NICHEDB_PAGE_LIMIT, NICHEDB_PAGE_LIMIT);
    const out: NichedbItem<T>[] = [];
    let after = query.after;
    for (let page = 0; page < maxPages; page++) {
      const rows = await items<T>({ ...query, sort: 'id', order: 'asc', limit: pageSize, after });
      out.push(...rows);
      if (rows.length < pageSize || out.length >= maxItems) break;
      after = rows[rows.length - 1]!.id;
    }
    return out.length > maxItems ? out.slice(0, maxItems) : out;
  }

  return {
    baseUrl,
    itemsUrl,
    items,
    walk,
    get requestCount() {
      return requestCount;
    },
  };
}
