/**
 * Deterministic in-memory BrokerConnectorPlugin.
 *
 * Two jobs: (1) let the shared conformance suite run in CI with no network or
 * credentials, and (2) give the equity engine a controllable broker for risk/
 * session/PDT tests (PRD §8, M2) — drive it to fill, partial-fill, or reject on
 * demand instead of waiting on a real venue.
 */
import type {
  BrokerConnectorPlugin,
  BrokerOrderArgs,
  BrokerOrderResult,
  BrokerPosition,
  BrokerQuote,
  MarketSession,
  PluginManifest,
} from './types.js';

export interface FakeBrokerOptions {
  buyingPowerUsd?: number;
  positions?: BrokerPosition[];
  quotes?: Record<string, BrokerQuote>;
  session?: MarketSession;
  /**
   * Force the status the next placed order resolves to. 'partial' attaches a
   * half fill; 'rejected' returns ok:false. Defaults to 'accepted' (resting).
   */
  nextOrderStatus?: BrokerOrderResult['status'];
}

const DEFAULT_SESSION: MarketSession = {
  status: 'open',
  timezone: 'America/New_York',
};

let seq = 0;

export class FakeBroker implements BrokerConnectorPlugin {
  readonly manifest: PluginManifest & { kind: 'broker' } = {
    id: 'fake',
    kind: 'broker',
    version: '0.0.0',
    name: 'Fake Broker (test)',
    author: 'b1dz',
    capabilities: ['asset:equity', 'broker:fake', 'market:us', 'feature:paper', 'feature:fractional'],
  };
  readonly broker = 'fake';
  readonly markets = ['us'];

  private bp: number;
  private pos: BrokerPosition[];
  private quotes: Record<string, BrokerQuote>;
  private sess: MarketSession;
  private nextStatus: BrokerOrderResult['status'];
  /** Orders currently resting/open, by id. */
  readonly orders = new Map<string, BrokerOrderArgs & { status: BrokerOrderResult['status'] }>();

  constructor(opts: FakeBrokerOptions = {}) {
    this.bp = opts.buyingPowerUsd ?? 100_000;
    this.pos = opts.positions ?? [];
    this.quotes = opts.quotes ?? {};
    this.sess = opts.session ?? DEFAULT_SESSION;
    this.nextStatus = opts.nextOrderStatus ?? 'accepted';
  }

  setSession(s: MarketSession): void { this.sess = s; }
  setNextOrderStatus(s: BrokerOrderResult['status']): void { this.nextStatus = s; }

  async session(): Promise<MarketSession> { return this.sess; }
  async buyingPowerUsd(): Promise<number> { return this.bp; }
  async positions(): Promise<BrokerPosition[]> { return [...this.pos]; }

  async quote(symbol: string): Promise<BrokerQuote> {
    return this.quotes[symbol] ?? { bid: 99.95, ask: 100.05, last: 100, ts: Date.now() };
  }

  async placeOrder(args: BrokerOrderArgs): Promise<BrokerOrderResult> {
    if (args.type === 'limit' && args.limitPrice == null) {
      return { ok: false, message: 'limit order requires limitPrice' };
    }
    if (args.qty == null && args.notionalUsd == null) {
      return { ok: false, message: 'order requires qty or notionalUsd' };
    }
    const id = `fake-${++seq}`;
    const status = this.nextStatus;
    if (status === 'rejected') {
      return { ok: false, message: 'rejected by fake broker', orderId: id, status };
    }
    this.orders.set(id, { ...args, status });
    const q = await this.quote(args.symbol);
    if (status === 'filled') {
      return { ok: true, message: 'filled', orderId: id, status, fillPrice: q.last, filledQty: args.qty };
    }
    if (status === 'partial') {
      return {
        ok: true, message: 'partially filled', orderId: id, status,
        fillPrice: q.last, filledQty: args.qty ? args.qty / 2 : undefined,
      };
    }
    return { ok: true, message: 'accepted', orderId: id, status: 'accepted' };
  }

  async cancelOrder(orderId: string): Promise<BrokerOrderResult> {
    const existed = this.orders.delete(orderId);
    return {
      ok: existed,
      message: existed ? 'canceled' : 'no such order',
      orderId,
      status: 'canceled',
    };
  }
}
