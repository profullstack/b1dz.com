/**
 * @b1dz/sdk — typed wrappers around the b1dz.com REST API.
 *
 * Every b1dz client (TUI, browser extension, web app, PWA, native mobile)
 * imports this and never talks to anything else. No third-party APIs, no
 * direct Supabase access, no local storage of business data.
 *
 * The SDK auto-refreshes access tokens via the refresh_token endpoint and
 * exposes a hook so the caller can persist new tokens (CLI writes them
 * back to ~/.config/b1dz/credentials.json; browsers update the cookie).
 */

export interface Tokens { accessToken: string; refreshToken: string; }

export interface B1dzClientOptions {
  baseUrl: string;
  tokens: Tokens;
  onRefresh?: (tokens: Tokens) => void | Promise<void>;
}

export interface DealDashCreds { phpsessid: string; rememberme: string; savedAt?: string; }
export interface MarketEntry { min: number; median: number; mean?: number; count: number; }
export interface AuctionPageInfo {
  name?: string;
  categoryName?: string;
  buyItNowPrice?: number;
  exchangeable?: boolean;
  productId?: number;
  noReEntry?: boolean;
  exchangedAt?: number;
  exchangedFor?: number;
}

export class B1dzClient {
  private baseUrl: string;
  private tokens: Tokens;
  private onRefresh?: (tokens: Tokens) => void | Promise<void>;

  constructor(opts: B1dzClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.tokens = opts.tokens;
    this.onRefresh = opts.onRefresh;
  }

  private async refresh(): Promise<boolean> {
    const res = await fetch(`${this.baseUrl}/api/auth/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refresh_token: this.tokens.refreshToken }),
    });
    if (!res.ok) return false;
    const { session } = await res.json() as { session?: { access_token: string; refresh_token: string } };
    if (!session) return false;
    this.tokens = { accessToken: session.access_token, refreshToken: session.refresh_token };
    if (this.onRefresh) await this.onRefresh(this.tokens);
    return true;
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const exec = async () => fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.tokens.accessToken}`,
      },
      body: body == null ? undefined : JSON.stringify(body),
    });
    let res = await exec();
    if (res.status === 401) {
      const refreshed = await this.refresh();
      if (refreshed) res = await exec();
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 200)}`);
    }
    return res.json() as Promise<T>;
  }

  // ----- generic storage (mostly used by state-sync) -----
  storage = {
    get: <T>(collection: string, key: string) =>
      this.request<{ value: T | null }>('GET', `/api/storage/${encodeURIComponent(collection)}/${encodeURIComponent(key)}`).then(r => r.value),
    put: <T>(collection: string, key: string, value: T) =>
      this.request<{ ok: true }>('PUT', `/api/storage/${encodeURIComponent(collection)}/${encodeURIComponent(key)}`, value),
    delete: (collection: string, key: string) =>
      this.request<{ ok: true }>('DELETE', `/api/storage/${encodeURIComponent(collection)}/${encodeURIComponent(key)}`),
    list: <T>(collection: string) =>
      this.request<{ items: T[] }>('GET', `/api/storage/${encodeURIComponent(collection)}`).then(r => r.items),
  };

  // ----- dealdash actions (server-side proxies the user's session) -----
  dealdash = {
    bookBid: (auctionId: number, count = 1) =>
      this.request<{ ok: true }>('POST', `/api/sources/dealdash/book-bid/${auctionId}`, { count }),
    cancelBid: (auctionId: number) =>
      this.request<{ ok: true }>('POST', `/api/sources/dealdash/cancel-bid/${auctionId}`),
    exchange: (auctionId: number, orderId: string) =>
      this.request<{ ok: true }>('POST', `/api/sources/dealdash/exchange/${auctionId}`, { orderId }),
    pageInfo: (auctionId: number) =>
      this.request<{ value: AuctionPageInfo | null }>('GET', `/api/sources/dealdash/page-info/${auctionId}`).then(r => r.value),
    marketPrice: (title: string) =>
      this.request<{ value: MarketEntry; cached: boolean }>('GET', `/api/sources/dealdash/market-price?title=${encodeURIComponent(title)}`).then(r => r.value),
  };
}

// ----- standalone auth helpers (don't need a client instance) -----
export interface AuthResponse {
  user: { id: string; email: string };
  session?: { access_token: string; refresh_token: string };
}

export async function signup(baseUrl: string, email: string, password: string): Promise<AuthResponse> {
  const res = await fetch(`${baseUrl}/api/auth/signup`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const json = (await res.json()) as AuthResponse & { error?: string };
  if (!res.ok) throw new Error(json.error || `signup failed: ${res.status}`);
  return json as AuthResponse;
}

export async function login(baseUrl: string, email: string, password: string): Promise<AuthResponse> {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const json = (await res.json()) as AuthResponse & { error?: string };
  if (!res.ok) throw new Error(json.error || `login failed: ${res.status}`);
  return json as AuthResponse;
}
