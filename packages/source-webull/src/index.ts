/**
 * source-webull — BrokerConnectorPlugin for Webull OpenAPI (US equities).
 *
 * PRD §6, Phase 3, demand-driven long tail. Webull's OpenAPI is region-specific
 * and the least publicly documented of the set, so this connector keeps every
 * host and path configurable and the request shapes conservative. The endpoint
 * paths below are placeholders modeled on Webull's OpenAPI conventions and MUST
 * be verified against the developer portal (and your region's host) before live
 * use; auth (app key/secret → bearer token) is owned by the engine.
 *
 *   GET    {base}/account/balance?accountId=…     buying power
 *   GET    {base}/account/positions?accountId=…   positions
 *   GET    {base}/market/quote?symbol=…           quote
 *   POST   {base}/trade/order                      place
 *   POST   {base}/trade/order/cancel               cancel
 */
import {
  classifyUsEquitySession,
  etParts,
  type BrokerConnectorPlugin,
  type BrokerOrderArgs,
  type BrokerOrderResult,
  type BrokerPosition,
  type BrokerQuote,
  type MarketSession,
  type PluginManifest,
} from '@b1dz/core';

const DEFAULT_BASE = 'https://api.webull.com/openapi';
const REG_OPEN = 9 * 60 + 30;
const REG_CLOSE = 16 * 60;

export interface WebullConfig {
  accessToken: string;
  accountId: string;
  /** Region/host override — Webull OpenAPI hosts differ by region. */
  baseUrl?: string;
  paper?: boolean;
  fetchImpl?: typeof fetch;
}

export class WebullApiError extends Error {
  constructor(public readonly statusCode: number, public readonly body: string) {
    super(`Webull API ${statusCode}: ${body}`);
    this.name = 'WebullApiError';
  }
}

export function mapWebullStatus(status: string): BrokerOrderResult['status'] {
  switch (status) {
    case 'FILLED':
    case 'Filled':
      return 'filled';
    case 'PARTIAL_FILLED':
    case 'PartiallyFilled':
      return 'partial';
    case 'FAILED':
    case 'REJECTED':
      return 'rejected';
    case 'CANCELLED':
    case 'CANCELED':
      return 'canceled';
    default:
      return 'accepted';
  }
}

export class WebullConnector implements BrokerConnectorPlugin {
  readonly manifest: PluginManifest & { kind: 'broker' };
  readonly broker = 'webull';
  readonly markets = ['us'];
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: WebullConfig) {
    if (!config.accessToken || !config.accountId) {
      throw new Error('WebullConnector: accessToken and accountId are required');
    }
    this.base = config.baseUrl ?? DEFAULT_BASE;
    this.fetchImpl = config.fetchImpl ?? fetch;
    const caps = ['asset:equity', 'broker:webull', 'market:us'];
    if (config.paper) caps.push('feature:paper');
    this.manifest = {
      id: 'webull',
      kind: 'broker',
      version: '0.1.0',
      name: 'Webull — US Equities',
      author: 'b1dz',
      description: 'US stocks & ETFs via the Webull OpenAPI. Region-specific host; endpoint paths require verification against the Webull developer portal.',
      capabilities: caps,
    };
  }

  private async req<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await this.fetchImpl(`${this.base}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.config.accessToken}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...(init?.headers as Record<string, string>),
      },
    });
    const text = await res.text();
    if (!res.ok) throw new WebullApiError(res.status, text);
    return (text ? JSON.parse(text) : {}) as T;
  }

  async session(symbol: string): Promise<MarketSession> {
    void symbol;
    const { weekday, minutes } = etParts(new Date());
    const isOpen = weekday >= 1 && weekday <= 5 && minutes >= REG_OPEN && minutes < REG_CLOSE;
    return classifyUsEquitySession({ isOpen });
  }

  async buyingPowerUsd(): Promise<number> {
    const r = await this.req<{ buyingPower?: string | number; cashBalance?: string | number }>(
      `/account/balance?accountId=${encodeURIComponent(this.config.accountId)}`,
    );
    return Number(r.buyingPower ?? r.cashBalance ?? 0) || 0;
  }

  async positions(): Promise<BrokerPosition[]> {
    const r = await this.req<{ positions?: Array<{ symbol: string; quantity: string | number; costPrice: string | number; marketValue: string | number }> }>(
      `/account/positions?accountId=${encodeURIComponent(this.config.accountId)}`,
    );
    return (r.positions ?? []).map((p) => ({
      symbol: p.symbol,
      qty: Number(p.quantity) || 0,
      avgEntry: Number(p.costPrice) || 0,
      marketValue: Number(p.marketValue) || 0,
      currency: 'USD',
    }));
  }

  async quote(symbol: string): Promise<BrokerQuote> {
    const r = await this.req<{ bid?: string | number; ask?: string | number; last?: string | number }>(
      `/market/quote?symbol=${encodeURIComponent(symbol)}`,
    );
    return { bid: Number(r.bid) || 0, ask: Number(r.ask) || 0, last: Number(r.last) || 0, ts: Date.now() };
  }

  async placeOrder(args: BrokerOrderArgs): Promise<BrokerOrderResult> {
    if (args.type === 'limit' && args.limitPrice == null) {
      return { ok: false, message: 'limit order requires limitPrice' };
    }
    let qty = args.qty;
    if (qty == null) {
      if (args.notionalUsd == null) return { ok: false, message: 'order requires qty or notionalUsd' };
      const { last } = await this.quote(args.symbol);
      if (!last) return { ok: false, message: 'no price to convert notional' };
      qty = Math.max(1, Math.floor(args.notionalUsd / last));
    }
    const order = {
      accountId: this.config.accountId,
      symbol: args.symbol,
      side: args.side.toUpperCase(),
      orderType: args.type === 'limit' ? 'LIMIT' : 'MARKET',
      quantity: qty,
      timeInForce: args.tif === 'gtc' ? 'GTC' : 'DAY',
      ...(args.type === 'limit' ? { limitPrice: args.limitPrice } : {}),
      ...(args.extendedHours ? { extendedHoursTrading: true } : {}),
    };
    try {
      const r = await this.req<{ orderId?: string; status?: string; msg?: string }>('/trade/order', {
        method: 'POST',
        body: JSON.stringify(order),
      });
      const status = mapWebullStatus(r.status ?? 'SUBMITTED');
      return { ok: status !== 'rejected', message: r.msg ?? `order ${r.orderId ?? 'accepted'}`, orderId: r.orderId, status };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  async cancelOrder(orderId: string): Promise<BrokerOrderResult> {
    try {
      await this.req('/trade/order/cancel', {
        method: 'POST',
        body: JSON.stringify({ accountId: this.config.accountId, orderId }),
      });
      return { ok: true, message: `order ${orderId} canceled`, orderId, status: 'canceled' };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err), orderId };
    }
  }
}

export function createWebullConnector(config: WebullConfig): WebullConnector {
  return new WebullConnector(config);
}
