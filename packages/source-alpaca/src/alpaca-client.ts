/**
 * Thin, dependency-free REST client for the Alpaca broker API.
 *
 * Covers exactly the surface the BrokerConnectorPlugin needs: account buying
 * power, positions, the market clock, latest quotes, and order place/cancel.
 * Uses global `fetch` (Node 22+ / edge) so the connector carries no transitive
 * HTTP dependency, matching the rest of the b1dz source packages.
 *
 * Credentials live in the engine layer and are passed in via AlpacaConfig —
 * they are never read from a global or exposed to strategy plugins.
 * See docs/prd-equities-v1.md §4 (execution model) and §9 (data).
 */

export interface AlpacaConfig {
  /** API key id + secret (paste-creds path). Optional if `accessToken` is set. */
  keyId?: string;
  secretKey?: string;
  /** OAuth bearer access token (OAuth login path). Takes precedence over key/secret. */
  accessToken?: string;
  /** true → paper-api.alpaca.markets (default), false → api.alpaca.markets */
  paper?: boolean;
  /** Market-data feed. 'iex' is the free dev tier (PRD §9); 'sip' needs a sub. */
  feed?: 'iex' | 'sip';
  /** Override the trading host (tests). */
  tradingBaseUrl?: string;
  /** Override the market-data host (tests). */
  dataBaseUrl?: string;
  /** Injectable fetch for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/** Raw Alpaca /v2/account shape (subset we use). */
export interface AlpacaAccount {
  buying_power: string;
  cash: string;
  currency: string;
  pattern_day_trader: boolean;
  daytrade_count: number;
  daytrading_buying_power: string;
}

/** Raw Alpaca /v2/positions element (subset). */
export interface AlpacaPositionRaw {
  symbol: string;
  qty: string;
  avg_entry_price: string;
  market_value: string;
  exchange?: string;
  asset_class?: string;
}

/** Raw Alpaca /v2/clock. */
export interface AlpacaClock {
  timestamp: string;     // ISO 8601
  is_open: boolean;
  next_open: string;     // ISO 8601
  next_close: string;    // ISO 8601
}

/** Raw Alpaca latest-quote element. */
export interface AlpacaQuoteRaw {
  bp: number;            // bid price
  ap: number;            // ask price
  t: string;             // RFC-3339 timestamp
}

export interface AlpacaTradeRaw {
  p: number;             // last trade price
  t: string;
}

/** Raw Alpaca order (subset of fields we map). */
export interface AlpacaOrderRaw {
  id: string;
  status: string;        // 'new' | 'accepted' | 'partially_filled' | 'filled' | 'rejected' | 'canceled' | …
  filled_qty: string;
  filled_avg_price: string | null;
  qty: string | null;
}

export interface AlpacaOrderRequest {
  symbol: string;
  side: 'buy' | 'sell';
  qty?: string;
  notional?: string;
  type: 'market' | 'limit';
  limit_price?: string;
  time_in_force: 'day' | 'gtc' | 'ioc';
  extended_hours?: boolean;
}

export class AlpacaApiError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly body: string,
    message?: string,
  ) {
    super(message ?? `Alpaca API ${statusCode}: ${body}`);
    this.name = 'AlpacaApiError';
  }
}

const PAPER_TRADING = 'https://paper-api.alpaca.markets';
const LIVE_TRADING = 'https://api.alpaca.markets';
const DATA_HOST = 'https://data.alpaca.markets';

export class AlpacaClient {
  private readonly tradingBase: string;
  private readonly dataBase: string;
  private readonly feed: 'iex' | 'sip';
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: AlpacaConfig) {
    if (!config.accessToken && (!config.keyId || !config.secretKey)) {
      throw new Error('AlpacaClient: provide accessToken (OAuth) or keyId + secretKey');
    }
    this.tradingBase =
      config.tradingBaseUrl ?? (config.paper === false ? LIVE_TRADING : PAPER_TRADING);
    this.dataBase = config.dataBaseUrl ?? DATA_HOST;
    this.feed = config.feed ?? 'iex';
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  get isPaper(): boolean {
    return this.config.paper !== false;
  }

  private headers(): Record<string, string> {
    // OAuth bearer takes precedence over key/secret when present.
    if (this.config.accessToken) {
      return { Authorization: `Bearer ${this.config.accessToken}`, 'Content-Type': 'application/json' };
    }
    return {
      'APCA-API-KEY-ID': this.config.keyId!,
      'APCA-API-SECRET-KEY': this.config.secretKey!,
      'Content-Type': 'application/json',
    };
  }

  private async request<T>(base: string, path: string, init?: RequestInit): Promise<T> {
    const res = await this.fetchImpl(`${base}${path}`, {
      ...init,
      headers: { ...this.headers(), ...(init?.headers as Record<string, string>) },
    });
    const text = await res.text();
    if (!res.ok) {
      throw new AlpacaApiError(res.status, text);
    }
    return (text ? JSON.parse(text) : undefined) as T;
  }

  account(): Promise<AlpacaAccount> {
    return this.request<AlpacaAccount>(this.tradingBase, '/v2/account');
  }

  positions(): Promise<AlpacaPositionRaw[]> {
    return this.request<AlpacaPositionRaw[]>(this.tradingBase, '/v2/positions');
  }

  clock(): Promise<AlpacaClock> {
    return this.request<AlpacaClock>(this.tradingBase, '/v2/clock');
  }

  async latestQuote(symbol: string): Promise<AlpacaQuoteRaw> {
    const r = await this.request<{ quote: AlpacaQuoteRaw }>(
      this.dataBase,
      `/v2/stocks/${encodeURIComponent(symbol)}/quotes/latest?feed=${this.feed}`,
    );
    return r.quote;
  }

  async latestTrade(symbol: string): Promise<AlpacaTradeRaw> {
    const r = await this.request<{ trade: AlpacaTradeRaw }>(
      this.dataBase,
      `/v2/stocks/${encodeURIComponent(symbol)}/trades/latest?feed=${this.feed}`,
    );
    return r.trade;
  }

  placeOrder(order: AlpacaOrderRequest): Promise<AlpacaOrderRaw> {
    return this.request<AlpacaOrderRaw>(this.tradingBase, '/v2/orders', {
      method: 'POST',
      body: JSON.stringify(order),
    });
  }

  cancelOrder(orderId: string): Promise<void> {
    return this.request<void>(this.tradingBase, `/v2/orders/${encodeURIComponent(orderId)}`, {
      method: 'DELETE',
    });
  }

  getOrder(orderId: string): Promise<AlpacaOrderRaw> {
    return this.request<AlpacaOrderRaw>(
      this.tradingBase,
      `/v2/orders/${encodeURIComponent(orderId)}`,
    );
  }
}
