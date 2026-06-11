/**
 * source-alpaca — the reference BrokerConnectorPlugin (PRD equities-v1 §6, Phase 1).
 *
 * Wraps a single Alpaca account (paper by default) behind the broker contract
 * in @b1dz/core. Strategies never see this object; the engine holds it, having
 * injected the user's credentials. The connector is signals-blind: it only
 * places, cancels, and reports — risk/PDT/session gating live in the engine.
 *
 *   session()        → /v2/clock, classified pre/open/post/closed
 *   buyingPowerUsd() → /v2/account buying_power
 *   positions()      → /v2/positions, mapped to BrokerPosition[]
 *   quote()          → latest IEX/SIP quote (last falls back to a trade print)
 *   placeOrder()     → /v2/orders (notional-first when supported)
 *   cancelOrder()    → DELETE /v2/orders/{id}
 *
 * Live execution is gated upstream by EQUITY_TRADE_EXECUTION (engine), exactly
 * as DEX_TRADE_EXECUTION gates DEX connectors. This package just talks to
 * whichever host (paper/live) its config selects.
 */
import { AlpacaClient } from './alpaca-client.js';
import { sessionFromClock } from './session.js';
import type {
  AlpacaConfig,
  AlpacaOrderRaw,
  BrokerConnectorPlugin,
  BrokerOrderArgs,
  BrokerOrderResult,
  BrokerPosition,
  BrokerQuote,
  MarketSession,
  PluginManifest,
} from './types.js';

export * from './alpaca-client.js';
export * from './session.js';
export { runBrokerConformance } from './conformance.js';
export { FakeBroker } from './fake-broker.js';
export type { FakeBrokerOptions } from './fake-broker.js';

const ALPACA_MARKETS = ['us'];

/** Map Alpaca's many order states onto the broker contract's five. */
export function mapOrderStatus(status: string): BrokerOrderResult['status'] {
  switch (status) {
    case 'filled':
      return 'filled';
    case 'partially_filled':
      return 'partial';
    case 'rejected':
      return 'rejected';
    case 'canceled':
    case 'expired':
    case 'done_for_day':
    case 'stopped':
      return 'canceled';
    default:
      // new, accepted, pending_new, pending_cancel, replaced, calculated, …
      return 'accepted';
  }
}

function orderResult(raw: AlpacaOrderRaw): BrokerOrderResult {
  const status = mapOrderStatus(raw.status);
  const filledQty = Number(raw.filled_qty) || 0;
  const fillPrice = raw.filled_avg_price != null ? Number(raw.filled_avg_price) : undefined;
  return {
    ok: status !== 'rejected',
    message: `order ${raw.id} ${raw.status}`,
    orderId: raw.id,
    status,
    filledQty: filledQty > 0 ? filledQty : undefined,
    fillPrice: fillPrice && fillPrice > 0 ? fillPrice : undefined,
  };
}

export class AlpacaConnector implements BrokerConnectorPlugin {
  readonly manifest: PluginManifest & { kind: 'broker' };
  readonly broker = 'alpaca';
  readonly markets = ALPACA_MARKETS;

  constructor(private readonly client: AlpacaClient) {
    const caps = [
      'asset:equity',
      'broker:alpaca',
      'market:us',
      'feature:fractional',
      'feature:extended-hours',
    ];
    if (client.isPaper) caps.push('feature:paper');
    this.manifest = {
      id: 'alpaca',
      kind: 'broker',
      version: '0.1.0',
      name: 'Alpaca — US Equities',
      author: 'b1dz',
      description:
        'Commission-free US stocks & ETFs via Alpaca. Fractional/notional orders, ' +
        'IEX market data (SIP via config), and a paper environment that mirrors live.',
      capabilities: caps,
    };
  }

  async session(symbol: string): Promise<MarketSession> {
    void symbol; // Alpaca exposes one US session; symbol is accepted for contract parity
    return sessionFromClock(await this.client.clock());
  }

  async buyingPowerUsd(): Promise<number> {
    const acct = await this.client.account();
    return Number(acct.buying_power) || 0;
  }

  async positions(): Promise<BrokerPosition[]> {
    const raw = await this.client.positions();
    return raw.map((p) => ({
      symbol: p.symbol,
      qty: Number(p.qty) || 0,
      avgEntry: Number(p.avg_entry_price) || 0,
      marketValue: Number(p.market_value) || 0,
      currency: 'USD',
      exchange: p.exchange,
    }));
  }

  async quote(symbol: string): Promise<BrokerQuote> {
    const q = await this.client.latestQuote(symbol);
    let last = 0;
    try {
      last = (await this.client.latestTrade(symbol)).p || 0;
    } catch {
      // No recent print (illiquid / closed): fall back to the bid/ask midpoint.
      last = q.bp && q.ap ? (q.bp + q.ap) / 2 : q.bp || q.ap || 0;
    }
    return { bid: q.bp || 0, ask: q.ap || 0, last, ts: Date.parse(q.t) || Date.now() };
  }

  async placeOrder(args: BrokerOrderArgs): Promise<BrokerOrderResult> {
    if (args.type === 'limit' && args.limitPrice == null) {
      return { ok: false, message: 'limit order requires limitPrice' };
    }
    if (args.qty == null && args.notionalUsd == null) {
      return { ok: false, message: 'order requires qty or notionalUsd' };
    }
    // Notional-first when the engine supplied it (PRD §8 fractional sizing);
    // Alpaca rejects sending both, so qty only when notional is absent.
    const useNotional = args.notionalUsd != null;
    try {
      const raw = await this.client.placeOrder({
        symbol: args.symbol,
        side: args.side,
        type: args.type,
        time_in_force: args.tif,
        ...(useNotional
          ? { notional: String(args.notionalUsd) }
          : { qty: String(args.qty) }),
        ...(args.type === 'limit' ? { limit_price: String(args.limitPrice) } : {}),
        ...(args.extendedHours ? { extended_hours: true } : {}),
      });
      return orderResult(raw);
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  async cancelOrder(orderId: string): Promise<BrokerOrderResult> {
    try {
      await this.client.cancelOrder(orderId);
      return { ok: true, message: `order ${orderId} canceled`, orderId, status: 'canceled' };
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : String(err),
        orderId,
      };
    }
  }
}

/**
 * Construct an Alpaca broker connector. Credentials come from the engine layer
 * (never from a global in plugin code). Defaults to the paper host.
 */
export function createAlpacaConnector(config: AlpacaConfig): AlpacaConnector {
  return new AlpacaConnector(new AlpacaClient(config));
}
