/**
 * Plugin contracts (v0).
 *
 * b1dz is evolving into a plugin platform: DEX connectors and strategies are
 * plugins that compose against a stable shape. This file is the contract —
 * types only, no runtime. A registry and loader come next session.
 *
 * Two kinds today:
 *   - ConnectorPlugin: wraps a single-venue DEX executor (one venue, one chain).
 *     First-party only in v0 — third-party connectors need a sandbox story.
 *   - StrategyPlugin: signals-only. Authors emit Signal objects from evaluate().
 *     b1dz owns signing, risk, approvals. Authors never touch keys.
 *
 * The full reasoning is in docs/prd-plugins-v0.md.
 */
import type { MarketSnapshot } from './market.js';

export type PluginKind = 'connector' | 'strategy';

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

export type Plugin = ConnectorPlugin | StrategyPlugin;
