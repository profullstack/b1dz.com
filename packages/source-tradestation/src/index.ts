/**
 * source-tradestation — BrokerConnectorPlugin for TradeStation (US equities).
 *
 * PRD §6, Phase 3. OAuth bearer-authenticated v3 API with a simulated-trading
 * host. Verify endpoints against the TradeStation API docs before live use.
 *
 *   GET    /brokerage/accounts                    account discovery
 *   GET    /brokerage/accounts/{id}/balances      buying power
 *   GET    /brokerage/accounts/{id}/positions     positions
 *   GET    /marketdata/quotes/{symbols}           quote
 *   POST   /orderexecution/orders                 place
 *   DELETE /orderexecution/orders/{orderId}       cancel
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

const PROD = 'https://api.tradestation.com/v3';
const SIM = 'https://sim-api.tradestation.com/v3';
const REG_OPEN = 9 * 60 + 30;
const REG_CLOSE = 16 * 60;

export interface TradeStationConfig {
  accessToken: string;
  accountId: string;
  /** true → sim host (default), false → production. */
  sim?: boolean;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export class TradeStationApiError extends Error {
  constructor(public readonly statusCode: number, public readonly body: string) {
    super(`TradeStation API ${statusCode}: ${body}`);
    this.name = 'TradeStationApiError';
  }
}

export function mapTradeStationStatus(status: string): BrokerOrderResult['status'] {
  switch (status) {
    case 'FLL':
    case 'Filled':
      return 'filled';
    case 'FPR':
    case 'PartiallyFilled':
      return 'partial';
    case 'REJ':
    case 'Rejected':
      return 'rejected';
    case 'CAN':
    case 'Canceled':
    case 'EXP':
      return 'canceled';
    default:
      return 'accepted';
  }
}

export class TradeStationConnector implements BrokerConnectorPlugin {
  readonly manifest: PluginManifest & { kind: 'broker' };
  readonly broker = 'tradestation';
  readonly markets = ['us'];
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: TradeStationConfig) {
    if (!config.accessToken || !config.accountId) {
      throw new Error('TradeStationConnector: accessToken and accountId are required');
    }
    this.base = config.baseUrl ?? (config.sim === false ? PROD : SIM);
    this.fetchImpl = config.fetchImpl ?? fetch;
    const caps = ['asset:equity', 'broker:tradestation', 'market:us'];
    if (config.sim !== false) caps.push('feature:paper');
    this.manifest = {
      id: 'tradestation',
      kind: 'broker',
      version: '0.1.0',
      name: 'TradeStation — US Equities',
      author: 'b1dz',
      description: 'US stocks & ETFs via the TradeStation v3 API. OAuth, simulated-trading host.',
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
    if (!res.ok) throw new TradeStationApiError(res.status, text);
    return (text ? JSON.parse(text) : {}) as T;
  }

  async session(symbol: string): Promise<MarketSession> {
    void symbol;
    const { weekday, minutes } = etParts(new Date());
    const isOpen = weekday >= 1 && weekday <= 5 && minutes >= REG_OPEN && minutes < REG_CLOSE;
    return classifyUsEquitySession({ isOpen });
  }

  async buyingPowerUsd(): Promise<number> {
    const r = await this.req<{ Balances?: Array<{ BuyingPower?: string | number; CashBalance?: string | number }> }>(
      `/brokerage/accounts/${encodeURIComponent(this.config.accountId)}/balances`,
    );
    const b = r.Balances?.[0] ?? {};
    return Number(b.BuyingPower ?? b.CashBalance ?? 0) || 0;
  }

  async positions(): Promise<BrokerPosition[]> {
    const r = await this.req<{ Positions?: Array<{ Symbol: string; Quantity: string | number; AveragePrice: string | number; MarketValue: string | number }> }>(
      `/brokerage/accounts/${encodeURIComponent(this.config.accountId)}/positions`,
    );
    return (r.Positions ?? []).map((p) => ({
      symbol: p.Symbol,
      qty: Number(p.Quantity) || 0,
      avgEntry: Number(p.AveragePrice) || 0,
      marketValue: Number(p.MarketValue) || 0,
      currency: 'USD',
    }));
  }

  async quote(symbol: string): Promise<BrokerQuote> {
    const r = await this.req<{ Quotes?: Array<{ Bid?: string | number; Ask?: string | number; Last?: string | number }> }>(
      `/marketdata/quotes/${encodeURIComponent(symbol)}`,
    );
    const q = r.Quotes?.[0] ?? {};
    return { bid: Number(q.Bid) || 0, ask: Number(q.Ask) || 0, last: Number(q.Last) || 0, ts: Date.now() };
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
      AccountID: this.config.accountId,
      Symbol: args.symbol,
      Quantity: String(qty),
      OrderType: args.type === 'limit' ? 'Limit' : 'Market',
      TradeAction: args.side.toUpperCase(),
      TimeInForce: { Duration: args.tif === 'gtc' ? 'GTC' : 'DAY' },
      ...(args.type === 'limit' ? { LimitPrice: String(args.limitPrice) } : {}),
    };
    try {
      const r = await this.req<{ Orders?: Array<{ OrderID?: string; Message?: string; Error?: string }> }>(
        '/orderexecution/orders',
        { method: 'POST', body: JSON.stringify(order) },
      );
      const o = r.Orders?.[0] ?? {};
      if (o.Error) return { ok: false, message: o.Error, orderId: o.OrderID };
      return { ok: true, message: o.Message ?? `order ${o.OrderID ?? 'accepted'}`, orderId: o.OrderID, status: 'accepted' };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  async cancelOrder(orderId: string): Promise<BrokerOrderResult> {
    try {
      await this.req(`/orderexecution/orders/${encodeURIComponent(orderId)}`, { method: 'DELETE' });
      return { ok: true, message: `order ${orderId} canceled`, orderId, status: 'canceled' };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err), orderId };
    }
  }
}

export function createTradeStationConnector(config: TradeStationConfig): TradeStationConnector {
  return new TradeStationConnector(config);
}
