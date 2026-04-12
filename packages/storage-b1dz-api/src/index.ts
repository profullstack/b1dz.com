/**
 * @b1dz/storage-b1dz-api — Storage adapter that proxies CRUD through the
 * b1dz.com REST API instead of talking to Postgres directly.
 *
 * This is what end-user CLIs use: no Supabase secrets, no direct DB access.
 * The API server (apps/web) verifies the JWT and stamps user_id; RLS does
 * the rest. The CLI is just another consumer of the same routes the web
 * dashboard already calls.
 *
 * Token refresh: on a 401 we POST refresh_token to /api/auth/refresh. The
 * `refresh` callback persists the new tokens (the CLI uses it to update
 * ~/.config/b1dz/credentials.json). One retry per request, then bubble.
 */

import type { Storage } from '@b1dz/core';

export interface Tokens {
  accessToken: string;
  refreshToken: string;
}

export interface B1dzApiStorageOptions {
  /** Base URL of the API. e.g. https://b1dz.com or http://localhost:3000 */
  baseUrl: string;
  /** Initial tokens. The adapter will refresh in-place when needed. */
  tokens: Tokens;
  /** Called after a successful refresh so the caller can persist new tokens. */
  onRefresh?: (tokens: Tokens) => void | Promise<void>;
}

export class B1dzApiStorage implements Storage {
  private baseUrl: string;
  private tokens: Tokens;
  private onRefresh?: (tokens: Tokens) => void | Promise<void>;
  private apiVersion: string | null = null;

  constructor(opts: B1dzApiStorageOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.tokens = opts.tokens;
    this.onRefresh = opts.onRefresh;
  }

  private captureVersion(res: Response) {
    const version = res.headers.get('x-b1dz-version');
    if (version) this.apiVersion = version;
  }

  getApiVersion(): string | null {
    return this.apiVersion;
  }

  private async refresh(): Promise<boolean> {
    const res = await fetch(`${this.baseUrl}/api/auth/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refresh_token: this.tokens.refreshToken }),
    });
    this.captureVersion(res);
    if (!res.ok) return false;
    const { session } = await res.json() as { session?: { access_token: string; refresh_token: string } };
    if (!session) return false;
    this.tokens = { accessToken: session.access_token, refreshToken: session.refresh_token };
    if (this.onRefresh) await this.onRefresh(this.tokens);
    return true;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const exec = async () => fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.tokens.accessToken}`,
      },
      body: body == null ? undefined : JSON.stringify(body),
    });
    let res = await exec();
    this.captureVersion(res);
    if (res.status === 401) {
      const refreshed = await this.refresh();
      if (refreshed) {
        res = await exec();
        this.captureVersion(res);
      }
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 200)}`);
    }
    return res.json() as Promise<T>;
  }

  async get<T>(collection: string, key: string): Promise<T | null> {
    const safeCol = encodeURIComponent(collection);
    const safeKey = encodeURIComponent(key);
    const { value } = await this.request<{ value: T | null }>('GET', `/api/storage/${safeCol}/${safeKey}`);
    return value;
  }

  async put<T>(collection: string, key: string, value: T): Promise<void> {
    const safeCol = encodeURIComponent(collection);
    const safeKey = encodeURIComponent(key);
    await this.request<{ ok: true }>('PUT', `/api/storage/${safeCol}/${safeKey}`, value);
  }

  async delete(collection: string, key: string): Promise<void> {
    const safeCol = encodeURIComponent(collection);
    const safeKey = encodeURIComponent(key);
    await this.request<{ ok: true }>('DELETE', `/api/storage/${safeCol}/${safeKey}`);
  }

  async list<T>(collection: string): Promise<T[]> {
    const safeCol = encodeURIComponent(collection);
    const { items } = await this.request<{ items: T[] }>('GET', `/api/storage/${safeCol}`);
    return items;
  }

  async query<T>(collection: string, predicate: (v: T) => boolean): Promise<T[]> {
    return (await this.list<T>(collection)).filter(predicate);
  }
}

// ----- standalone helpers (used by the CLI auth flow, not by Storage) -----

export interface AuthResponse {
  user: { id: string; email: string };
  session?: { access_token: string; refresh_token: string; expires_at?: number };
}

export async function apiSignup(baseUrl: string, email: string, password: string): Promise<AuthResponse> {
  const res = await fetch(`${baseUrl}/api/auth/signup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const json = await res.json() as AuthResponse | { error: string };
  if (!res.ok) throw new Error(('error' in json && json.error) || `signup failed: ${res.status}`);
  return json as AuthResponse;
}

export async function apiLogin(baseUrl: string, email: string, password: string): Promise<AuthResponse> {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const json = await res.json() as AuthResponse | { error: string };
  if (!res.ok) throw new Error(('error' in json && json.error) || `login failed: ${res.status}`);
  return json as AuthResponse;
}

export async function apiMe(baseUrl: string, accessToken: string): Promise<{ userId: string; email: string | null }> {
  const res = await fetch(`${baseUrl}/api/me`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`me failed: ${res.status}`);
  return (await res.json()) as { userId: string; email: string | null };
}
