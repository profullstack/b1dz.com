/**
 * HTTP for research cards: TTL cache, in-flight de-duplication, a polite
 * per-host queue, timeouts, and per-source health for the Data status card.
 * No dependencies; uses the global fetch.
 */
import { SourceError } from './types.js';

export interface RequestOptions {
  /** Source label for health tracking and error messages, e.g. "SEC". */
  source: string;
  /** Cache lifetime in seconds. Default 300. 0 disables caching. */
  ttl?: number;
  headers?: Record<string, string>;
  timeoutMs?: number;
  method?: 'GET' | 'POST';
  /** JSON body for POST. */
  body?: unknown;
}

export interface SourceHealth {
  source: string;
  ok: number;
  failed: number;
  lastOkAt?: string;
  lastError?: string;
  lastErrorAt?: string;
}

export interface HttpOptions {
  fetch?: typeof fetch;
  /** Sent to hosts that want a descriptive client (SEC, Treasury). */
  agent?: string;
  /** Minimum gap between requests to one host, ms. Default 120. */
  hostGapMs?: number;
  maxCacheEntries?: number;
}

const BROWSER_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

/** Hosts that ask automated clients to identify themselves rather than look like a browser. */
const DESCRIPTIVE_HOSTS = /(^|\.)(stlouisfed\.org|sec\.gov|treasury\.gov|federalreserve\.gov|bankofcanada\.ca|europa\.eu|bis\.org|imf\.org|oecd\.org)$/;

interface CacheEntry {
  at: number;
  ttl: number;
  body: string;
}

export class Http {
  private readonly fetchImpl: typeof fetch;
  private readonly agent: string;
  private readonly hostGapMs: number;
  private readonly maxCacheEntries: number;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, Promise<string>>();
  private readonly hostTail = new Map<string, Promise<void>>();
  private readonly healthBySource = new Map<string, SourceHealth>();

  constructor(opts: HttpOptions = {}) {
    this.fetchImpl = opts.fetch ?? fetch;
    this.agent = opts.agent ?? 'b1dz-research/0.4 (+https://b1dz.com)';
    this.hostGapMs = opts.hostGapMs ?? 120;
    this.maxCacheEntries = opts.maxCacheEntries ?? 800;
  }

  async json<T = unknown>(url: string, opts: RequestOptions): Promise<T> {
    const body = await this.text(url, { ...opts, headers: { accept: 'application/json', ...opts.headers } });
    try {
      return JSON.parse(body) as T;
    } catch {
      this.record(opts.source, 'not JSON');
      throw new SourceError(opts.source, `expected JSON, got: ${body.slice(0, 80).replace(/\s+/g, ' ')}`);
    }
  }

  async text(url: string, opts: RequestOptions): Promise<string> {
    const ttl = opts.ttl ?? 300;
    const key = `${opts.method ?? 'GET'} ${url} ${opts.body === undefined ? '' : JSON.stringify(opts.body)}`;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < hit.ttl * 1000) return hit.body;
    const pending = this.inflight.get(key);
    if (pending) return pending;

    const run = this.request(url, opts)
      .then((body) => {
        if (ttl > 0) this.remember(key, { at: Date.now(), ttl, body });
        return body;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, run);
    return run;
  }

  /** Drop every cached response (the TUI's Refresh). */
  clearCache(): void {
    this.cache.clear();
  }

  health(): SourceHealth[] {
    return [...this.healthBySource.values()].sort((a, b) => a.source.localeCompare(b.source));
  }

  private remember(key: string, entry: CacheEntry): void {
    if (this.cache.size >= this.maxCacheEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(key, entry);
  }

  /** Requests to one host run one after another, `hostGapMs` apart. */
  private async turn(host: string): Promise<void> {
    const prev = this.hostTail.get(host) ?? Promise.resolve();
    const mine = prev.then(() => new Promise<void>((resolve) => setTimeout(resolve, this.hostGapMs)));
    this.hostTail.set(host, mine);
    await prev;
  }

  private async request(url: string, opts: RequestOptions): Promise<string> {
    let host = '';
    try {
      host = new URL(url).hostname;
    } catch {
      throw new SourceError(opts.source, `bad URL: ${url}`);
    }
    await this.turn(host);

    const headers: Record<string, string> = {
      'user-agent': DESCRIPTIVE_HOSTS.test(host) ? this.agent : BROWSER_UA,
      'accept-language': 'en-US,en;q=0.9',
      ...opts.headers,
    };
    let body: string | undefined;
    if (opts.body !== undefined) {
      body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
      if (!('content-type' in headers)) headers['content-type'] = 'application/json';
    }

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 20_000);
    try {
      const res = await this.fetchImpl(url, {
        method: opts.method ?? (body === undefined ? 'GET' : 'POST'),
        headers,
        body,
        signal: ctrl.signal,
        redirect: 'follow',
      });
      const text = await res.text();
      if (!res.ok) {
        const why = res.status === 429 ? 'rate limited (HTTP 429)' : `HTTP ${res.status}`;
        this.record(opts.source, why);
        throw new SourceError(opts.source, why, res.status);
      }
      this.record(opts.source);
      return text;
    } catch (e) {
      if (e instanceof SourceError) throw e;
      const why = (e as Error).name === 'AbortError' ? 'timed out' : (e as Error).message || 'network error';
      this.record(opts.source, why);
      throw new SourceError(opts.source, why);
    } finally {
      clearTimeout(timer);
    }
  }

  private record(source: string, error?: string): void {
    const h = this.healthBySource.get(source) ?? { source, ok: 0, failed: 0 };
    const now = new Date().toISOString();
    if (error) {
      h.failed += 1;
      h.lastError = error;
      h.lastErrorAt = now;
    } else {
      h.ok += 1;
      h.lastOkAt = now;
    }
    this.healthBySource.set(source, h);
  }
}

/**
 * Try providers in order and return the first that answers. The winner's
 * name becomes the card's `source`; the losers are listed in `notes` so a
 * substituted provider is always labelled.
 */
export async function firstOf<T>(
  providers: { name: string; run: () => Promise<T> }[],
): Promise<{ value: T; source: string; skipped: string[] }> {
  const skipped: string[] = [];
  let last: unknown;
  for (const p of providers) {
    try {
      const value = await p.run();
      return { value, source: p.name, skipped };
    } catch (e) {
      last = e;
      skipped.push(`${p.name} unavailable (${(e as Error).message.replace(/^[^:]+:\s*/, '')})`);
    }
  }
  throw last instanceof Error ? last : new Error('no provider answered');
}

/** Parse CSV text (quoted fields, embedded commas and newlines) into rows of strings. */
export function parseCsv(text: string, delimiter = ','): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === delimiter) {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** CSV with a header row to objects keyed by header. */
export function csvObjects(text: string, delimiter = ','): Record<string, string>[] {
  const rows = parseCsv(text, delimiter);
  if (rows.length < 2) return [];
  const head = rows[0].map((h) => h.trim());
  return rows.slice(1).map((r) => Object.fromEntries(head.map((h, i) => [h, (r[i] ?? '').trim()])));
}

/** Number from provider text: "$1,234.5", "12.3%", "(4.2)", "N/A", "--" -> number or null. */
export function num(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  let s = v.trim();
  if (!s || /^(n\/?a|--?|null|nan|\.)$/i.test(s)) return null;
  let sign = 1;
  if (/^\(.*\)$/.test(s)) {
    sign = -1;
    s = s.slice(1, -1);
  }
  let mult = 1;
  const suffix = /([kmbt])$/i.exec(s);
  if (suffix && /^[-+$\d.,\s]+[kmbt]$/i.test(s)) {
    mult = { k: 1e3, m: 1e6, b: 1e9, t: 1e12 }[suffix[1].toLowerCase() as 'k' | 'm' | 'b' | 't'];
    s = s.slice(0, -1);
  }
  s = s.replace(/[$,%\s]/g, '');
  if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(s)) return null;
  return sign * mult * Number(s);
}
