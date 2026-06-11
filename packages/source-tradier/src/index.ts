/**
 * source-tradier — BrokerConnectorPlugin for Tradier Brokerage (US equities).
 *
 * Tradier is the PRD's "cleanest second implementation" (§6, Phase 2): a
 * brokerage-API company with a documented REST surface and a sandbox host.
 * Building it against the same contract validates that BrokerConnectorPlugin
 * isn't secretly Alpaca-shaped.
 *
 * Auth: bearer access token (OAuth or a personal access token), passed in by
 * the engine — never read from a global or exposed to strategies.
 *
 * Endpoints (verify against https://documentation.tradier.com before live use):
 *   GET    /v1/user/profile                       account discovery
 *   GET    /v1/accounts/{id}/balances             buying power
 *   GET    /v1/accounts/{id}/positions            positions
 *   GET    /v1/markets/quotes?symbols=…           quote
 *   GET    /v1/markets/clock                       session (state incl. pre/post)
 *   POST   /v1/accounts/{id}/orders               place (form-encoded)
 *   DELETE /v1/accounts/{id}/orders/{orderId}     cancel
 *
 * Tradier has no fractional/notional orders, so notionalUsd is converted to
 * whole shares via the latest price.
 */
import {
  classifyUsEquitySession,
  type BrokerConnectorPlugin,
  type BrokerOrderArgs,
  type BrokerOrderResult,
  type BrokerPosition,
  type BrokerQuote,
  type MarketSession,
  type PluginManifest,
} from '@b1dz/core';

const PROD = 'https://api.tradier.com';
const SANDBOX = 'https://sandbox.tradier.com';

export interface TradierConfig {
  accessToken: string;
  accountId: string;
  /** true → sandbox host (default), false → production. */
  sandbox?: boolean;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export class TradierApiError extends Error {
  constructor(public readonly statusCode: number, public readonly body: string) {
    super(`Tradier API ${statusCode}: ${body}`);
    this.name = 'TradierApiError';
  }
}

/** Tradier order/quote states → the five contract states. */
export function mapTradierStatus(status: string): BrokerOrderResult['status'] {
  switch (status) {
    case 'filled':
      return 'filled';
    case 'partially_filled':
      return 'partial';
    case 'rejected':
    case 'error':
      return 'rejected';
    case 'canceled':
    case 'expired':
      return 'canceled';
    default:
      // ok, open, pending, calculated, accepted, …
      return 'accepted';
  }
}

export class TradierConnector implements BrokerConnectorPlugin {
  readonly manifest: PluginManifest & { kind: 'broker' };
  readonly broker = 'tradier';
  readonly markets = ['us'];
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: TradierConfig) {
    if (!config.accessToken || !config.accountId) {
      throw new Error('TradierConnector: accessToken and accountId are required');
    }
    this.base = config.baseUrl ?? (config.sandbox === false ? PROD : SANDBOX);
    this.fetchImpl = config.fetchImpl ?? fetch;
    const caps = ['asset:equity', 'broker:tradier', 'market:us', 'feature:extended-hours'];
    if (config.sandbox !== false) caps.push('feature:paper');
    this.manifest = {
      id: 'tradier',
      kind: 'broker',
      version: '0.1.0',
      name: 'Tradier — US Equities',
      author: 'b1dz',
      description: 'US stocks & ETFs via Tradier Brokerage. REST + streaming, OAuth, sandbox environment. Whole-share orders (no fractional).',
      capabilities: caps,
    };
  }

  private async get<T>(path: string): Promise<T> {
    const res = await this.fetchImpl(`${this.base}${path}`, {
      headers: { Authorization: `Bearer ${this.config.accessToken}`, Accept: 'application/json' },
    });
    const text = await res.text();
    if (!res.ok) throw new TradierApiError(res.status, text);
    return (text ? JSON.parse(text) : {}) as T;
  }

  async session(symbol: string): Promise<MarketSession> {
    void symbol;
    const r = await this.get<{ clock?: { state?: string; next_change?: string } }>('/v1/markets/clock');
    const state = r.clock?.state ?? 'closed';
    // Tradier reports pre/post directly; trust it over the wall-clock heuristic.
    if (state === 'premarket') return { status: 'pre', timezone: 'America/New_York' };
    if (state === 'postmarket') return { status: 'post', timezone: 'America/New_York' };
    return classifyUsEquitySession({ isOpen: state === 'open' });
  }

  async buyingPowerUsd(): Promise<number> {
    const r = await this.get<{ balances?: { margin?: { stock_buying_power?: number }; cash?: { cash_available?: number }; total_cash?: number } }>(
      `/v1/accounts/${encodeURIComponent(this.config.accountId)}/balances`,
    );
    const b = r.balances ?? {};
    return Number(b.margin?.stock_buying_power ?? b.cash?.cash_available ?? b.total_cash ?? 0) || 0;
  }

  async positions(): Promise<BrokerPosition[]> {
    const r = await this.get<{ positions?: { position?: TradierPositionRaw | TradierPositionRaw[] } | 'null' }>(
      `/v1/accounts/${encodeURIComponent(this.config.accountId)}/positions`,
    );
    const raw = r.positions;
    if (!raw || raw === 'null' || !raw.position) return [];
    const list = Array.isArray(raw.position) ? raw.position : [raw.position];
    return list.map((p) => {
      const qty = Number(p.quantity) || 0;
      const cost = Number(p.cost_basis) || 0;
      return {
        symbol: p.symbol,
        qty,
        avgEntry: qty !== 0 ? cost / qty : 0,
        marketValue: 0, // Tradier positions omit live market value; engine marks via quote()
        currency: 'USD',
      };
    });
  }

  async quote(symbol: string): Promise<BrokerQuote> {
    const r = await this.get<{ quotes?: { quote?: TradierQuoteRaw | TradierQuoteRaw[] } }>(
      `/v1/markets/quotes?symbols=${encodeURIComponent(symbol)}`,
    );
    const q0 = r.quotes?.quote;
    const q = Array.isArray(q0) ? q0[0] : q0;
    return {
      bid: Number(q?.bid) || 0,
      ask: Number(q?.ask) || 0,
      last: Number(q?.last) || 0,
      ts: q?.trade_date ? Number(q.trade_date) : Date.now(),
    };
  }

  async placeOrder(args: BrokerOrderArgs): Promise<BrokerOrderResult> {
    if (args.type === 'limit' && args.limitPrice == null) {
      return { ok: false, message: 'limit order requires limitPrice' };
    }
    let qty = args.qty;
    if (qty == null) {
      if (args.notionalUsd == null) return { ok: false, message: 'order requires qty or notionalUsd' };
      const { last } = await this.quote(args.symbol);
      if (!last) return { ok: false, message: 'no price to convert notional to shares' };
      qty = Math.max(1, Math.floor(args.notionalUsd / last)); // Tradier: whole shares only
    }
    // Tradier duration: day | gtc | pre | post (no IOC) — map IOC to day.
    const duration = args.extendedHours ? 'pre' : args.tif === 'ioc' ? 'day' : args.tif;
    const form = new URLSearchParams({
      class: 'equity',
      symbol: args.symbol,
      side: args.side,
      quantity: String(qty),
      type: args.type,
      duration,
      ...(args.type === 'limit' ? { price: String(args.limitPrice) } : {}),
    });
    try {
      const res = await this.fetchImpl(`${this.base}/v1/accounts/${encodeURIComponent(this.config.accountId)}/orders`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.accessToken}`,
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: form.toString(),
      });
      const text = await res.text();
      if (!res.ok) return { ok: false, message: `Tradier ${res.status}: ${text}` };
      const body = JSON.parse(text) as { order?: { id?: number | string; status?: string }; errors?: unknown };
      const id = body.order?.id != null ? String(body.order.id) : undefined;
      const status = mapTradierStatus(body.order?.status ?? 'ok');
      return { ok: status !== 'rejected', message: `order ${id ?? '?'} ${body.order?.status ?? 'ok'}`, orderId: id, status };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  async cancelOrder(orderId: string): Promise<BrokerOrderResult> {
    try {
      const res = await this.fetchImpl(
        `${this.base}/v1/accounts/${encodeURIComponent(this.config.accountId)}/orders/${encodeURIComponent(orderId)}`,
        { method: 'DELETE', headers: { Authorization: `Bearer ${this.config.accessToken}`, Accept: 'application/json' } },
      );
      const text = await res.text();
      if (!res.ok) return { ok: false, message: `Tradier ${res.status}: ${text}`, orderId };
      return { ok: true, message: `order ${orderId} canceled`, orderId, status: 'canceled' };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err), orderId };
    }
  }
}

interface TradierPositionRaw { symbol: string; quantity: number | string; cost_basis: number | string; }
interface TradierQuoteRaw { bid?: number; ask?: number; last?: number; trade_date?: number; }

export function createTradierConnector(config: TradierConfig): TradierConnector {
  return new TradierConnector(config);
}
