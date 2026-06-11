/**
 * Plugin contracts (v0).
 *
 * b1dz is evolving into a plugin platform: DEX connectors and strategies are
 * plugins that compose against a stable shape. This file is the contract —
 * types only, no runtime. A registry and loader come next session.
 *
 * Three kinds today:
 *   - ConnectorPlugin: wraps a single-venue DEX executor (one venue, one chain).
 *     First-party only in v0 — third-party connectors need a sandbox story.
 *   - StrategyPlugin: signals-only. Authors emit Signal objects from evaluate().
 *     b1dz owns signing, risk, approvals. Authors never touch keys.
 *   - BrokerConnectorPlugin: wraps a single stock broker (one or more markets).
 *     First-party + server-side only — same trust rule as DEX connectors.
 *     Broker OAuth tokens / API keys live in the engine layer, never in plugin
 *     code. See docs/prd-equities-v1.md.
 *
 * The full reasoning is in docs/prd-plugins-v0.md and docs/prd-equities-v1.md.
 */
import type { MarketSnapshot, MarketSession } from './market.js';

export type PluginKind = 'connector' | 'strategy' | 'broker';

export interface PluginManifest {
  id: string;
  kind: PluginKind;
  version: string;
  name: string;
  author?: string;
  description?: string;
  /** Free-form tags that downstream code can filter on. Examples:
   *  connectors: 'chain:base', 'venue:uniswap-v3'
   *  strategies: 'style:momentum', 'timeframe:1m' */
  capabilities: string[];
  // Marketplace fields (pricing, revenue share, signature hash, protocol version)
  // land in v1 — intentionally omitted here.
}

export interface DexTradeResult {
  ok: boolean;
  message: string;
  fillPrice?: number;
  baseVolume?: number;
  quoteAmountUsd?: number;
  txId?: string;
}

export interface ConnectorPlugin {
  manifest: PluginManifest & { kind: 'connector' };
  venue: string;
  chain: string;
  quoteBalanceUsd(): Promise<number>;
  buy(args: { pair: string; amountUsd: number; slippageBps: number }): Promise<DexTradeResult>;
  sell(args: { pair: string; baseVolume: number; slippageBps: number }): Promise<DexTradeResult>;
}

export interface Signal {
  side: 'buy' | 'sell';
  /** 0..1 strength */
  strength: number;
  reason: string;
}

export interface StrategyPlugin {
  manifest: PluginManifest & { kind: 'strategy' };
  evaluate(snap: MarketSnapshot, history: MarketSnapshot[]): Signal | null;
}

// --- Broker connectors (equities). See docs/prd-equities-v1.md §5. ---

/** MarketSession is defined in market.ts (MarketSnapshot references it) and
 *  re-exported here so the broker contract surface is self-contained. */
export type { MarketSession };

export interface BrokerOrderResult {
  ok: boolean;
  message: string;
  orderId?: string;
  status?: 'accepted' | 'filled' | 'partial' | 'rejected' | 'canceled';
  fillPrice?: number;
  filledQty?: number;
}

export interface BrokerPosition {
  symbol: string;
  qty: number;            // fractional allowed
  avgEntry: number;
  marketValue: number;
  currency: string;       // 'USD', 'CAD', 'GBP', …
  exchange?: string;      // 'NASDAQ', 'LSE', 'TSE', …
}

export interface BrokerQuote {
  bid: number;
  ask: number;
  last: number;
  ts: number;
}

export interface BrokerOrderArgs {
  symbol: string;
  side: 'buy' | 'sell';
  qty?: number;                    // shares (fractional ok where supported)
  notionalUsd?: number;            // engine prefers notional when broker supports it
  type: 'market' | 'limit';
  limitPrice?: number;
  tif: 'day' | 'gtc' | 'ioc';
  extendedHours?: boolean;
}

export interface BrokerConnectorPlugin {
  manifest: PluginManifest & { kind: 'broker' };
  broker: string;                    // 'alpaca' | 'ibkr' | 'tradier' | …
  markets: string[];                 // 'us', 'ca', 'uk', 'jp', …
  session(symbol: string): Promise<MarketSession>;
  buyingPowerUsd(): Promise<number>;
  positions(): Promise<BrokerPosition[]>;
  quote(symbol: string): Promise<BrokerQuote>;
  placeOrder(args: BrokerOrderArgs): Promise<BrokerOrderResult>;
  cancelOrder(orderId: string): Promise<BrokerOrderResult>;
}

export type Plugin = ConnectorPlugin | StrategyPlugin | BrokerConnectorPlugin;
