/**
 * source-schwab — BrokerConnectorPlugin for Charles Schwab (US equities).
 *
 * Schwab brings the largest US retail base (PRD §6, Phase 3). It exposes the
 * Trader API (orders/accounts) and a Market Data API (quotes), both OAuth
 * bearer-authenticated. Accounts are addressed by an encrypted "account hash",
 * not the raw account number.
 *
 * Auth (OAuth bearer) is owned by the engine; token refresh is the engine's job.
 * Verify endpoints against Schwab's developer portal before live use.
 *
 *   GET    /trader/v1/accounts/{hash}?fields=positions   balances + positions
 *   GET    /marketdata/v1/quotes?symbols=…                quote
 *   POST   /trader/v1/accounts/{hash}/orders              place (201 + Location)
 *   DELETE /trader/v1/accounts/{hash}/orders/{orderId}    cancel
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

const TRADER = 'https://api.schwabapi.com/trader/v1';
const MARKETDATA = 'https://api.schwabapi.com/marketdata/v1';
const REG_OPEN = 9 * 60 + 30;
const REG_CLOSE = 16 * 60;

export interface SchwabConfig {
  accessToken: string;
  accountHash: string;
  traderBaseUrl?: string;
  dataBaseUrl?: string;
  fetchImpl?: typeof fetch;
}

export class SchwabApiError extends Error {
  constructor(public readonly statusCode: number, public readonly body: string) {
    super(`Schwab API ${statusCode}: ${body}`);
    this.name = 'SchwabApiError';
  }
}

export function mapSchwabStatus(status: string): BrokerOrderResult['status'] {
  switch (status) {
    case 'FILLED':
      return 'filled';
    case 'PARTIALLY_FILLED':
      return 'partial';
    case 'REJECTED':
      return 'rejected';
    case 'CANCELED':
    case 'EXPIRED':
      return 'canceled';
    default:
      return 'accepted';
  }
}

export class SchwabConnector implements BrokerConnectorPlugin {
  readonly manifest: PluginManifest & { kind: 'broker' };
  readonly broker = 'schwab';
  readonly markets = ['us'];
  private readonly trader: string;
  private readonly data: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: SchwabConfig) {
    if (!config.accessToken || !config.accountHash) {
      throw new Error('SchwabConnector: accessToken and accountHash are required');
    }
    this.trader = config.traderBaseUrl ?? TRADER;
    this.data = config.dataBaseUrl ?? MARKETDATA;
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.manifest = {
      id: 'schwab',
      kind: 'broker',
      version: '0.1.0',
      name: 'Charles Schwab — US Equities',
      author: 'b1dz',
      description: 'US stocks & ETFs via the Schwab Trader API. OAuth, ~120 req/min. Whole-share orders.',
      capabilities: ['asset:equity', 'broker:schwab', 'market:us', 'data:sip'],
    };
  }

  private async req<T>(base: string, path: string, init?: RequestInit): Promise<{ body: T; res: Response }> {
    const res = await this.fetchImpl(`${base}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.config.accessToken}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...(init?.headers as Record<string, string>),
      },
    });
    const text = await res.text();
    if (!res.ok) throw new SchwabApiError(res.status, text);
    return { body: (text ? JSON.parse(text) : {}) as T, res };
  }

  private async account(withPositions = false): Promise<SchwabAccount> {
    const q = withPositions ? '?fields=positions' : '';
    const { body } = await this.req<{ securitiesAccount: SchwabAccount }>(this.trader, `/accounts/${encodeURIComponent(this.config.accountHash)}${q}`);
    return body.securitiesAccount;
  }

  async session(symbol: string): Promise<MarketSession> {
    void symbol;
    const { weekday, minutes } = etParts(new Date());
    const isOpen = weekday >= 1 && weekday <= 5 && minutes >= REG_OPEN && minutes < REG_CLOSE;
    return classifyUsEquitySession({ isOpen });
  }

  async buyingPowerUsd(): Promise<number> {
    const a = await this.account();
    const b = a.currentBalances ?? {};
    return Number(b.buyingPower ?? b.cashAvailableForTrading ?? 0) || 0;
  }

  async positions(): Promise<BrokerPosition[]> {
    const a = await this.account(true);
    return (a.positions ?? []).map((p) => {
      const qty = (Number(p.longQuantity) || 0) - (Number(p.shortQuantity) || 0);
      return {
        symbol: p.instrument?.symbol ?? '',
        qty,
        avgEntry: Number(p.averagePrice) || 0,
        marketValue: Number(p.marketValue) || 0,
        currency: 'USD',
      };
    });
  }

  async quote(symbol: string): Promise<BrokerQuote> {
    const { body } = await this.req<Record<string, { quote?: { bidPrice?: number; askPrice?: number; lastPrice?: number; quoteTime?: number } }>>(
      this.data,
      `/quotes?symbols=${encodeURIComponent(symbol)}`,
    );
    const q = body[symbol]?.quote ?? {};
    return { bid: Number(q.bidPrice) || 0, ask: Number(q.askPrice) || 0, last: Number(q.lastPrice) || 0, ts: Number(q.quoteTime) || Date.now() };
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
      qty = Math.max(1, Math.floor(args.notionalUsd / last)); // Schwab: whole shares
    }
    const order = {
      orderType: args.type === 'limit' ? 'LIMIT' : 'MARKET',
      session: args.extendedHours ? 'SEAMLESS' : 'NORMAL',
      duration: args.tif === 'gtc' ? 'GOOD_TILL_CANCEL' : 'DAY',
      orderStrategyType: 'SINGLE',
      ...(args.type === 'limit' ? { price: args.limitPrice } : {}),
      orderLegCollection: [{
        instruction: args.side.toUpperCase(),
        quantity: qty,
        instrument: { symbol: args.symbol, assetType: 'EQUITY' },
      }],
    };
    try {
      const { res } = await this.req<unknown>(this.trader, `/accounts/${encodeURIComponent(this.config.accountHash)}/orders`, {
        method: 'POST',
        body: JSON.stringify(order),
      });
      // Schwab returns 201 with the new order id in the Location header.
      const loc = res.headers.get('location') ?? '';
      const orderId = loc.split('/').filter(Boolean).at(-1);
      return { ok: true, message: `order ${orderId ?? 'accepted'}`, orderId, status: 'accepted' };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  async cancelOrder(orderId: string): Promise<BrokerOrderResult> {
    try {
      await this.req(this.trader, `/accounts/${encodeURIComponent(this.config.accountHash)}/orders/${encodeURIComponent(orderId)}`, { method: 'DELETE' });
      return { ok: true, message: `order ${orderId} canceled`, orderId, status: 'canceled' };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err), orderId };
    }
  }
}

interface SchwabAccount {
  currentBalances?: { buyingPower?: number; cashAvailableForTrading?: number };
  positions?: Array<{ instrument?: { symbol?: string }; longQuantity?: number; shortQuantity?: number; averagePrice?: number; marketValue?: number }>;
}

export function createSchwabConnector(config: SchwabConfig): SchwabConnector {
  return new SchwabConnector(config);
}
