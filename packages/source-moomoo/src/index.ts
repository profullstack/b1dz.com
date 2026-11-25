/**
 * source-moomoo: BrokerConnectorPlugin for moomoo (US equities).
 *
 * Talks to the moomoo OpenAPI over plain REST (https://webapi.moomoo.com),
 * the gateway-free path: no OpenD process anywhere. Auth is an OAuth 2.1
 * bearer token (scopes quote:read, trade:read, trade:write), passed in by the
 * engine and never read from a global or shown to strategies.
 *
 * moomoo keeps live and paper trading on separate endpoint families with
 * different wire shapes, so this connector has two code paths behind one
 * contract:
 *
 *   live   /api/v1.0/accounts/...        envelope { s: "ok", d } | { s: "error", errcode, errmsg }
 *   paper  /api/v1.0/sim-trade/...       envelope { ret_code, ret_msg, data }
 *   quotes /api/v1.0/quote/...           envelope { ret_code, ret_msg, data }
 *
 * Endpoints used (https://open.moomoo.com/api/overview/):
 *   GET    /accounts/authorized_trd_accs            live account discovery
 *   GET    /accounts/{id}/funds?currency=USD        buying power ("power")
 *   GET    /accounts/{id}/positions                 positions
 *   GET    /accounts/{id}/orders?trd_market=US      open + last 24h orders
 *   POST   /accounts/{id}/orders                    place
 *   POST   /accounts/{id}/order_confirm             acknowledge a broker warning
 *   DELETE /accounts/{id}/orders/{oid}?exchange=…   cancel
 *   GET    /sim-trade/accounts                      paper account discovery (market_id 100 = US)
 *   GET    /sim-trade/{id}/cash-info | positions | orders
 *   POST   /sim-trade/{id}/orders | orders/{oid}/cancel
 *   POST   /quote/snapshot | /quote/market-state
 *
 * moomoo has no notional orders here, so notionalUsd becomes whole shares at
 * the latest price. Orders are not idempotent on moomoo's side: a timed-out
 * place must be checked against listOrders() before it is retried.
 */
import {
  classifyUsEquitySession,
  etParts,
  type BrokerConnectorPlugin,
  type BrokerOrder,
  type BrokerOrderArgs,
  type BrokerOrderResult,
  type BrokerPosition,
  type BrokerQuote,
  type MarketSession,
  type PluginManifest,
} from '@b1dz/core';

const HOST = 'https://webapi.moomoo.com';
const API = '/api/v1.0';
/** moomoo's market id for a US paper (margin) account. */
const SIM_US_MARKET = 100;
/** `enable_market` value for US on a live account. */
const LIVE_US_MARKET = 2;

export interface MoomooConfig {
  /** OAuth 2.1 bearer access token. */
  accessToken: string;
  /** Account id. Blank: the first US account (live or paper, per `paper`). */
  accountId?: string;
  /** true (default): the paper account. false: real money. */
  paper?: boolean;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export class MoomooApiError extends Error {
  constructor(public readonly statusCode: number, public readonly code: number | string | undefined, message: string) {
    super(message);
    this.name = 'MoomooApiError';
  }
}

interface TradeEnvelope<T> {
  s?: string;
  d?: T;
  errcode?: number;
  errmsg?: string;
  need_order_confirm?: boolean;
  confirm_id?: string;
  jump_url?: string;
  code?: number;
}
interface DataEnvelope<T> {
  ret_code?: number;
  ret_msg?: string;
  data?: T;
  error?: { code?: string; message?: string };
  code?: number;
}

/**
 * moomoo account ids are uint64 and arrive as bare JSON numbers, which lose
 * their low digits in a double. Quote them before parsing.
 */
export function parseMoomooJson<T>(text: string): T {
  return JSON.parse(text.replace(/("(?:account_id|acc_id)"\s*:\s*)(\d{16,})/g, '$1"$2"')) as T;
}

/** "US.AAPL" for the wire. Accepts AAPL, aapl, US.AAPL. */
export function toMoomooCode(symbol: string): string {
  const s = symbol.trim().toUpperCase();
  return /^[A-Z]{2}\./.test(s) ? s : `US.${s}`;
}

/** "AAPL" from "US.AAPL" (or from a bare symbol). */
export function fromMoomooCode(code: string): string {
  return code.trim().toUpperCase().replace(/^[A-Z]{2}\./, '');
}

type OrderState = { status: NonNullable<BrokerOrderResult['status']>; open: boolean };

/** Live order_status strings -> the five contract states. */
export function mapMoomooStatus(status: string): OrderState {
  switch (status) {
    case 'FILLED_ALL':
      return { status: 'filled', open: false };
    case 'FILLED_PART':
      return { status: 'partial', open: true };
    case 'CANCELLED_PART':
    case 'CANCELLED_ALL':
    case 'DELETED':
      return { status: 'canceled', open: false };
    case 'FAILED':
    case 'DISABLED':
      return { status: 'rejected', open: false };
    default:
      // WAITING_SUBMIT, SUBMITTING, SUBMITTED
      return { status: 'accepted', open: true };
  }
}

/** Paper order status ints -> the five contract states. */
export function mapMoomooSimStatus(status: number): OrderState {
  switch (status) {
    case 4:
      return { status: 'filled', open: false };
    case 3:
      return { status: 'partial', open: true };
    case 5:
    case 7:
      return { status: 'canceled', open: false };
    case 6:
      return { status: 'rejected', open: false };
    default:
      // 1 pending new, 2 submitted
      return { status: 'accepted', open: true };
  }
}

/** market_state strings -> a session. Unknown values read as closed. */
export function sessionFromMarketState(state: string | undefined): MarketSession['status'] {
  switch ((state ?? '').toUpperCase()) {
    case 'MORNING':
    case 'AFTERNOON':
      return 'open';
    case 'PRE_MARKET_BEGIN':
      return 'pre';
    case 'AFTER_HOURS_BEGIN':
      return 'post';
    default:
      return 'closed';
  }
}

const n = (v: unknown): number => {
  const x = typeof v === 'number' ? v : Number.parseFloat(String(v ?? ''));
  return Number.isFinite(x) ? x : 0;
};
/** Microsecond Unix time (string or number) -> ISO 8601. */
const microsIso = (v: unknown): string | undefined => {
  const us = Number(v);
  return Number.isFinite(us) && us > 0 ? new Date(us / 1000).toISOString() : undefined;
};

interface LiveOrderRaw {
  order_id: string;
  code: string;
  exchange?: string;
  side: string;
  order_type: string;
  order_status: string;
  qty: string;
  price?: string;
  dealt_qty?: string;
  dealt_avg_price?: string;
  create_time?: number | string;
}
interface SimOrderRaw {
  order_id: string;
  symbol: string;
  side: number;
  order_type: number;
  status: number;
  qty: string;
  cum_qty?: string;
  price?: string;
  avg_fill_price?: string;
  create_time?: string;
}

export class MoomooConnector implements BrokerConnectorPlugin {
  readonly manifest: PluginManifest & { kind: 'broker' };
  readonly broker = 'moomoo';
  readonly markets = ['us'];
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;
  private readonly paper: boolean;
  private accountId: string | undefined;

  constructor(private readonly config: MoomooConfig) {
    if (!config.accessToken) throw new Error('MoomooConnector: accessToken is required');
    this.base = (config.baseUrl ?? HOST).replace(/\/$/, '');
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.paper = config.paper !== false;
    this.accountId = config.accountId?.trim() || undefined;
    const caps = ['asset:equity', 'broker:moomoo', 'market:us', 'feature:extended-hours'];
    if (this.paper) caps.push('feature:paper');
    this.manifest = {
      id: 'moomoo',
      kind: 'broker',
      version: '0.1.0',
      name: 'moomoo: US Equities',
      author: 'b1dz',
      description: 'US stocks & ETFs via the moomoo OpenAPI (REST, OAuth 2.1). Live and paper accounts. Whole-share orders.',
      capabilities: caps,
    };
  }

  get isPaper(): boolean {
    return this.paper;
  }

  // ---- transport -----------------------------------------------------------

  private async raw(method: string, path: string, body?: unknown): Promise<{ status: number; text: string }> {
    const res = await this.fetchImpl(`${this.base}${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.config.accessToken}`,
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, text: await res.text() };
  }

  private static authMessage(status: number, code: number | undefined): string | null {
    if (code === -12102) return 'moomoo session expired: reconnect moomoo in Settings';
    if (code === -12006 || status === 401) return 'moomoo rejected the access token: reconnect moomoo in Settings';
    if (code === -12009 || status === 439) return 'moomoo blocked this request: the connection lacks the needed permission (grant quotes and trading when you connect)';
    if (code === -12011 || status === 429) return 'moomoo rate limit reached: try again in a minute';
    return null;
  }

  /** Live trading call. Returns the whole envelope so callers can see need_order_confirm. */
  private async trade<T>(method: string, path: string, body?: unknown): Promise<TradeEnvelope<T>> {
    const { status, text } = await this.raw(method, path, body);
    let env: TradeEnvelope<T>;
    try {
      env = parseMoomooJson<TradeEnvelope<T>>(text || '{}');
    } catch {
      throw new MoomooApiError(status, undefined, `moomoo ${status}: ${text.slice(0, 200)}`);
    }
    const auth = MoomooConnector.authMessage(status, env.code ?? env.errcode);
    if (auth) throw new MoomooApiError(status, env.code ?? env.errcode, auth);
    if (env.s === 'ok' || env.need_order_confirm) return env;
    throw new MoomooApiError(status, env.errcode ?? env.code, env.errmsg || `moomoo ${status}: ${text.slice(0, 200)}`);
  }

  /** Quote or paper-trading call ({ ret_code, data }). Errors can ride on HTTP 200. */
  private async data<T>(method: string, path: string, body?: unknown): Promise<T> {
    const { status, text } = await this.raw(method, path, body);
    let env: DataEnvelope<T>;
    try {
      env = parseMoomooJson<DataEnvelope<T>>(text || '{}');
    } catch {
      throw new MoomooApiError(status, undefined, `moomoo ${status}: ${text.slice(0, 200)}`);
    }
    const auth = MoomooConnector.authMessage(status, env.code ?? env.ret_code);
    if (auth) throw new MoomooApiError(status, env.code ?? env.ret_code, auth);
    if (env.ret_code === 0 && env.data !== undefined) return env.data;
    throw new MoomooApiError(status, env.ret_code ?? env.code, env.error?.message || env.ret_msg || `moomoo ${status}: ${text.slice(0, 200)}`);
  }

  /** The account every call uses, discovered once when none was configured. */
  async account(): Promise<string> {
    if (this.accountId) return this.accountId;
    if (this.paper) {
      const d = await this.data<{ accounts?: { account_id: string; market_id: number }[] }>('GET', '/sim-trade/accounts');
      const acc = (d.accounts ?? []).find((a) => a.market_id === SIM_US_MARKET);
      if (!acc) throw new MoomooApiError(200, undefined, 'no US paper trading account on this moomoo login');
      this.accountId = String(acc.account_id);
    } else {
      const env = await this.trade<{ accounts?: { account_id: string; enable_market?: number[] }[] }>('GET', '/accounts/authorized_trd_accs');
      const acc = (env.d?.accounts ?? []).find((a) => (a.enable_market ?? []).includes(LIVE_US_MARKET));
      if (!acc) throw new MoomooApiError(200, undefined, 'no US trading account on this moomoo login');
      this.accountId = String(acc.account_id);
    }
    return this.accountId;
  }

  // ---- contract ------------------------------------------------------------

  async session(symbol: string): Promise<MarketSession> {
    try {
      const d = await this.data<{ market_state_list?: { market_state?: string }[] }>('POST', '/quote/market-state', {
        code_list: [toMoomooCode(symbol)],
        is_contain_ba: true,
      });
      const state = d.market_state_list?.[0]?.market_state;
      if (state && state !== 'NONE') return { status: sessionFromMarketState(state), timezone: 'America/New_York' };
    } catch {
      /* fall through to the wall clock */
    }
    // No answer from moomoo: classify by the New York clock (holidays read as open).
    const { weekday, minutes } = etParts(new Date());
    return classifyUsEquitySession({ isOpen: weekday >= 1 && weekday <= 5 && minutes >= 570 && minutes < 960 });
  }

  async buyingPowerUsd(): Promise<number> {
    const acc = encodeURIComponent(await this.account());
    if (this.paper) {
      const d = await this.data<{ max_power_long?: string; balance?: string }>('GET', `/sim-trade/${acc}/cash-info`);
      return n(d.max_power_long ?? d.balance);
    }
    const env = await this.trade<{ power?: string; cash?: string }>('GET', `/accounts/${acc}/funds?currency=USD`);
    return n(env.d?.power ?? env.d?.cash);
  }

  async positions(): Promise<BrokerPosition[]> {
    const acc = encodeURIComponent(await this.account());
    if (this.paper) {
      const d = await this.data<{ positions?: { symbol: string; qty: string; cost_price?: string; mv?: string; pstn_type?: number }[] }>(
        'GET',
        `/sim-trade/${acc}/positions?market=${SIM_US_MARKET}`,
      );
      return (d.positions ?? []).map((p) => ({
        symbol: fromMoomooCode(p.symbol),
        qty: p.pstn_type === 1 ? -n(p.qty) : n(p.qty),
        avgEntry: n(p.cost_price),
        marketValue: n(p.mv),
        currency: 'USD',
      }));
    }
    const env = await this.trade<{ code: string; qty: string; cost_price?: string; market_val?: string; currency?: string; position_side?: string }[]>(
      'GET',
      `/accounts/${acc}/positions`,
    );
    return (env.d ?? [])
      .filter((p) => p.code.toUpperCase().startsWith('US.'))
      .map((p) => ({
        symbol: fromMoomooCode(p.code),
        qty: p.position_side === 'SHORT' ? -n(p.qty) : n(p.qty),
        avgEntry: n(p.cost_price),
        marketValue: n(p.market_val),
        currency: p.currency ?? 'USD',
      }));
  }

  async quote(symbol: string): Promise<BrokerQuote> {
    const code = toMoomooCode(symbol);
    const d = await this.data<{ snapshot_list?: { code: string; last_price?: number | string; bid_price?: number | string; ask_price?: number | string; update_time?: number }[] }>(
      'POST',
      '/quote/snapshot',
      { code_list: [code] },
    );
    const q = (d.snapshot_list ?? []).find((s) => s.code === code) ?? d.snapshot_list?.[0];
    if (!q) throw new MoomooApiError(200, -7, `moomoo has no quote for ${fromMoomooCode(code)}`);
    return { bid: n(q.bid_price), ask: n(q.ask_price), last: n(q.last_price), ts: n(q.update_time) || Date.now() };
  }

  async placeOrder(args: BrokerOrderArgs): Promise<BrokerOrderResult> {
    if (args.type === 'limit' && args.limitPrice == null) return { ok: false, message: 'limit order requires limitPrice' };
    try {
      let qty = args.qty;
      if (qty == null) {
        if (args.notionalUsd == null) return { ok: false, message: 'order requires qty or notionalUsd' };
        const { last } = await this.quote(args.symbol);
        if (!last) return { ok: false, message: 'no price to convert notional to shares' };
        qty = Math.floor(args.notionalUsd / last); // moomoo: whole shares only
      }
      if (!Number.isInteger(qty) || qty < 1) return { ok: false, message: 'moomoo takes whole shares only (at least 1)' };
      const acc = encodeURIComponent(await this.account());
      const price = args.type === 'limit' ? String(args.limitPrice) : undefined;

      if (this.paper) {
        const d = await this.data<{ order_id?: string }>('POST', `/sim-trade/${acc}/orders`, {
          market: SIM_US_MARKET,
          symbol: toMoomooCode(args.symbol),
          order_type: args.type === 'limit' ? 1 : 3,
          order_side: args.side === 'buy' ? 1 : 2,
          qty: String(qty),
          ...(price ? { price } : {}),
          order_trade_time_type: args.extendedHours && args.type === 'limit' ? 2 : 1,
        });
        return { ok: true, message: `paper order ${d.order_id ?? '?'} submitted`, orderId: d.order_id, status: 'accepted' };
      }

      const env = await this.trade<{ order_id?: string }>('POST', `/accounts/${acc}/orders`, {
        code: toMoomooCode(args.symbol),
        qty: String(qty),
        ...(price ? { price } : {}),
        side: args.side === 'buy' ? 'BUY' : 'SELL',
        order_type: args.type === 'limit' ? 'LIMIT' : 'MARKET',
        time_in_force: args.tif === 'gtc' ? 'GTC' : args.tif === 'ioc' ? 'IOC' : 'DAY',
        // Market orders trade in regular hours only on moomoo.
        ...(args.extendedHours && args.type === 'limit' ? { session: 'RTH+Pre/Post-Mkt' } : {}),
        remark: 'b1dz',
      });
      return MoomooConnector.placed(env);
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err), status: 'rejected' };
    }
  }

  private static placed(env: TradeEnvelope<{ order_id?: string }>): BrokerOrderResult {
    if (env.need_order_confirm && env.confirm_id) {
      return { ok: false, message: env.errmsg || 'moomoo wants this order confirmed', needsConfirm: { id: env.confirm_id, url: env.jump_url } };
    }
    const id = env.d?.order_id;
    return { ok: true, message: `order ${id ?? '?'} submitted`, orderId: id, status: 'accepted' };
  }

  /** Acknowledge the warning moomoo returned with need_order_confirm (live only). */
  async confirmOrder(confirmId: string): Promise<BrokerOrderResult> {
    if (this.paper) return { ok: false, message: 'paper orders need no confirmation' };
    try {
      const acc = encodeURIComponent(await this.account());
      return MoomooConnector.placed(await this.trade<{ order_id?: string }>('POST', `/accounts/${acc}/order_confirm`, { confirm_id: confirmId }));
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err), status: 'rejected' };
    }
  }

  private async liveOrders(): Promise<LiveOrderRaw[]> {
    const acc = encodeURIComponent(await this.account());
    const env = await this.trade<{ orders?: LiveOrderRaw[] }>('GET', `/accounts/${acc}/orders?trd_market=US&page_size=100`);
    return env.d?.orders ?? [];
  }

  async listOrders(): Promise<BrokerOrder[]> {
    const newestFirst = (a: BrokerOrder, b: BrokerOrder) => (b.createdAt ?? '').localeCompare(a.createdAt ?? '');
    if (this.paper) {
      const acc = encodeURIComponent(await this.account());
      const d = await this.data<{ orders?: SimOrderRaw[] }>('GET', `/sim-trade/${acc}/orders?market=${SIM_US_MARKET}`);
      return (d.orders ?? [])
        .map((o): BrokerOrder => {
          const st = mapMoomooSimStatus(o.status);
          return {
            orderId: o.order_id,
            symbol: fromMoomooCode(o.symbol),
            side: o.side === 1 || o.side === 4 ? 'buy' : 'sell',
            type: o.order_type === 1 ? 'limit' : o.order_type === 3 ? 'market' : 'other',
            qty: n(o.qty),
            filledQty: n(o.cum_qty),
            limitPrice: o.order_type === 1 ? n(o.price) : undefined,
            fillPrice: n(o.avg_fill_price) || undefined,
            status: st.status,
            open: st.open,
            createdAt: microsIso(o.create_time),
          };
        })
        .sort(newestFirst);
    }
    return (await this.liveOrders())
      .map((o): BrokerOrder => {
        const st = mapMoomooStatus(o.order_status);
        return {
          orderId: o.order_id,
          symbol: fromMoomooCode(o.code),
          side: o.side === 'BUY' || o.side === 'BUY_BACK' ? 'buy' : 'sell',
          type: o.order_type === 'LIMIT' ? 'limit' : o.order_type === 'MARKET' ? 'market' : 'other',
          qty: n(o.qty),
          filledQty: n(o.dealt_qty),
          limitPrice: o.order_type === 'LIMIT' ? n(o.price) : undefined,
          fillPrice: n(o.dealt_avg_price) || undefined,
          status: st.status,
          open: st.open,
          createdAt: microsIso(o.create_time),
        };
      })
      .sort(newestFirst);
  }

  async cancelOrder(orderId: string): Promise<BrokerOrderResult> {
    try {
      const acc = encodeURIComponent(await this.account());
      if (this.paper) {
        await this.data<{ order_id?: string }>('POST', `/sim-trade/${acc}/orders/${encodeURIComponent(orderId)}/cancel`, { market: SIM_US_MARKET });
        return { ok: true, message: `order ${orderId} canceled`, orderId, status: 'canceled' };
      }
      // Cancel needs the order's own exchange, which only the order carries.
      const order = (await this.liveOrders()).find((o) => o.order_id === orderId);
      if (!order?.exchange) return { ok: false, message: `order ${orderId} is not an open moomoo order`, orderId };
      await this.trade<unknown>('DELETE', `/accounts/${acc}/orders/${encodeURIComponent(orderId)}?exchange=${encodeURIComponent(order.exchange)}`);
      return { ok: true, message: `order ${orderId} canceled`, orderId, status: 'canceled' };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err), orderId };
    }
  }
}

export function createMoomooConnector(config: MoomooConfig): MoomooConnector {
  return new MoomooConnector(config);
}
