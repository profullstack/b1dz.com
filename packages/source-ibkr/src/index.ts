/**
 * source-ibkr — BrokerConnectorPlugin for Interactive Brokers (multi-market).
 *
 * IBKR is the PRD's heavy connector (§6, Phase 2): it unlocks the international
 * goal — one connector reaching LSE, TSE, XETRA, HKEX, TSX and more. It talks
 * to the IBKR Client Portal Web API, which runs behind a session-authenticated
 * gateway (local or a managed per-user gateway — PRD §12 Q2).
 *
 * Operational caveats (documented, not hidden):
 *   - Auth is the gateway's session, kept alive by tickling /tickle. baseUrl
 *     points at that gateway; the engine owns keepalive.
 *   - Market data + orders key off IBKR `conid`, not symbols, so quote()/
 *     placeOrder() resolve symbol→conid via /iserver/secdef/search (cached).
 *   - Order submission can return a confirmation question; live use must reply
 *     via /iserver/reply/{id}. We surface that rather than auto-confirming.
 *   - There is no clock endpoint; session() is a US-wall-clock approximation
 *     until the core exchange-calendar service lands (PRD §12 Q3).
 *
 * Verify endpoints against IBKR's Client Portal Web API docs before live use.
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

export interface IbkrConfig {
  /** Client Portal gateway base, e.g. 'https://localhost:5000/v1/api'. */
  baseUrl: string;
  /** IBKR account id (e.g. 'U1234567'). If omitted, resolved from /iserver/accounts. */
  accountId?: string;
  /** Optional bearer for OAuth gateways; session-cookie gateways need none. */
  accessToken?: string;
  fetchImpl?: typeof fetch;
}

export class IbkrApiError extends Error {
  constructor(public readonly statusCode: number, public readonly body: string) {
    super(`IBKR API ${statusCode}: ${body}`);
    this.name = 'IbkrApiError';
  }
}

export function mapIbkrStatus(status: string): BrokerOrderResult['status'] {
  switch (status) {
    case 'Filled':
      return 'filled';
    case 'PartiallyFilled':
      return 'partial';
    case 'Rejected':
    case 'Inactive':
      return 'rejected';
    case 'Cancelled':
    case 'Canceled':
      return 'canceled';
    default:
      // Submitted, PreSubmitted, PendingSubmit, …
      return 'accepted';
  }
}

const REG_OPEN = 9 * 60 + 30;
const REG_CLOSE = 16 * 60;

export class IbkrConnector implements BrokerConnectorPlugin {
  readonly manifest: PluginManifest & { kind: 'broker' };
  readonly broker = 'ibkr';
  readonly markets = ['us', 'ca', 'uk', 'de', 'jp', 'hk'];
  private readonly fetchImpl: typeof fetch;
  private accountId?: string;
  private readonly conidCache = new Map<string, number>();

  constructor(private readonly config: IbkrConfig) {
    if (!config.baseUrl) throw new Error('IbkrConnector: baseUrl (gateway) is required');
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.accountId = config.accountId;
    this.manifest = {
      id: 'ibkr',
      kind: 'broker',
      version: '0.1.0',
      name: 'Interactive Brokers — Global',
      author: 'b1dz',
      description: 'US + international equities via the IBKR Client Portal Web API. Reaches LSE, TSE, XETRA, HKEX, TSX and more through one connector. Requires a running IBKR gateway session.',
      capabilities: ['asset:equity', 'broker:ibkr', 'market:us', 'market:intl', 'feature:fractional'],
    };
  }

  private async req<T>(path: string, init?: RequestInit): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json', 'Content-Type': 'application/json' };
    if (this.config.accessToken) headers.Authorization = `Bearer ${this.config.accessToken}`;
    const res = await this.fetchImpl(`${this.config.baseUrl}${path}`, {
      ...init,
      headers: { ...headers, ...(init?.headers as Record<string, string>) },
    });
    const text = await res.text();
    if (!res.ok) throw new IbkrApiError(res.status, text);
    return (text ? JSON.parse(text) : {}) as T;
  }

  private async resolveAccount(): Promise<string> {
    if (this.accountId) return this.accountId;
    const r = await this.req<{ accounts?: string[]; selectedAccount?: string }>('/iserver/accounts');
    this.accountId = r.selectedAccount ?? r.accounts?.[0];
    if (!this.accountId) throw new Error('IBKR: no account available');
    return this.accountId;
  }

  private async resolveConid(symbol: string): Promise<number> {
    const cached = this.conidCache.get(symbol);
    if (cached != null) return cached;
    const r = await this.req<Array<{ conid: number | string }>>(
      `/iserver/secdef/search?symbol=${encodeURIComponent(symbol)}`,
    );
    const conid = Number(r?.[0]?.conid);
    if (!conid) throw new Error(`IBKR: no conid for ${symbol}`);
    this.conidCache.set(symbol, conid);
    return conid;
  }

  async session(symbol: string): Promise<MarketSession> {
    void symbol;
    // No clock endpoint — approximate US regular hours from the NY wall clock.
    const { weekday, minutes } = etParts(new Date());
    const isOpen = weekday >= 1 && weekday <= 5 && minutes >= REG_OPEN && minutes < REG_CLOSE;
    return classifyUsEquitySession({ isOpen });
  }

  async buyingPowerUsd(): Promise<number> {
    const acct = await this.resolveAccount();
    const r = await this.req<Record<string, { amount?: number }>>(`/portfolio/${encodeURIComponent(acct)}/summary`);
    return Number(r.buyingpower?.amount ?? r.availablefunds?.amount ?? 0) || 0;
  }

  async positions(): Promise<BrokerPosition[]> {
    const acct = await this.resolveAccount();
    const r = await this.req<IbkrPositionRaw[]>(`/portfolio/${encodeURIComponent(acct)}/positions/0`);
    return (r ?? []).map((p) => ({
      symbol: p.ticker ?? p.contractDesc ?? String(p.conid),
      qty: Number(p.position) || 0,
      avgEntry: Number(p.avgCost) || 0,
      marketValue: Number(p.mktValue) || 0,
      currency: p.currency ?? 'USD',
    }));
  }

  async quote(symbol: string): Promise<BrokerQuote> {
    const conid = await this.resolveConid(symbol);
    // fields: 31=last, 84=bid, 86=ask
    const r = await this.req<Array<Record<string, string | number>>>(
      `/iserver/marketdata/snapshot?conids=${conid}&fields=31,84,86`,
    );
    const s = r?.[0] ?? {};
    return {
      bid: Number(s['84']) || 0,
      ask: Number(s['86']) || 0,
      last: Number(s['31']) || 0,
      ts: Date.now(),
    };
  }

  async placeOrder(args: BrokerOrderArgs): Promise<BrokerOrderResult> {
    if (args.type === 'limit' && args.limitPrice == null) {
      return { ok: false, message: 'limit order requires limitPrice' };
    }
    if (args.qty == null && args.notionalUsd == null) {
      return { ok: false, message: 'order requires qty or notionalUsd' };
    }
    try {
      const acct = await this.resolveAccount();
      const conid = await this.resolveConid(args.symbol);
      let qty = args.qty;
      if (qty == null) {
        const { last } = await this.quote(args.symbol);
        if (!last) return { ok: false, message: 'no price to convert notional' };
        qty = args.notionalUsd! / last; // IBKR supports fractional on eligible names
      }
      const order = {
        conid,
        orderType: args.type === 'limit' ? 'LMT' : 'MKT',
        side: args.side.toUpperCase(),
        quantity: qty,
        tif: args.tif.toUpperCase(),
        ...(args.type === 'limit' ? { price: args.limitPrice } : {}),
        ...(args.extendedHours ? { outsideRTH: true } : {}),
      };
      const r = await this.req<Array<{ order_id?: string; id?: string; order_status?: string; error?: string }>>(
        `/iserver/account/${encodeURIComponent(acct)}/orders`,
        { method: 'POST', body: JSON.stringify({ orders: [order] }) },
      );
      const first = r?.[0] ?? {};
      // A reply 'id' without an order_id means IBKR returned a confirmation
      // question; live use must POST /iserver/reply/{id}. Surface it.
      const orderId = first.order_id ?? first.id;
      if (first.error) return { ok: false, message: first.error, orderId };
      const status = mapIbkrStatus(first.order_status ?? 'Submitted');
      return { ok: true, message: `order ${orderId ?? '?'} ${first.order_status ?? 'submitted'}`, orderId, status };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  async cancelOrder(orderId: string): Promise<BrokerOrderResult> {
    try {
      const acct = await this.resolveAccount();
      await this.req(`/iserver/account/${encodeURIComponent(acct)}/order/${encodeURIComponent(orderId)}`, {
        method: 'DELETE',
      });
      return { ok: true, message: `order ${orderId} canceled`, orderId, status: 'canceled' };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err), orderId };
    }
  }
}

interface IbkrPositionRaw {
  conid: number | string;
  ticker?: string;
  contractDesc?: string;
  position: number | string;
  avgCost: number | string;
  mktValue: number | string;
  currency?: string;
}

export function createIbkrConnector(config: IbkrConfig): IbkrConnector {
  return new IbkrConnector(config);
}
