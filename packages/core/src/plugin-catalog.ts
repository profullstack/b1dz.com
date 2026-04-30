/**
 * Plugin catalog — static metadata the store renders.
 *
 * This is intentionally not a runtime registry. The daemon decides which
 * plugins to actually arm (based on env + user settings); the catalog is
 * the "what exists / could be installed" surface the web app shows.
 *
 * Third-party entries land here via a content pipeline in v1; for now this
 * is b1dz's first-party set.
 */
import type { PluginManifest } from './plugins.js';

export interface CatalogEntry {
  manifest: PluginManifest;
  /** 'ready' = armed first-party. 'preview' = shipped but gated. 'coming-soon' = listed, not yet built. */
  status: 'ready' | 'preview' | 'coming-soon';
  /** Pricing for v1 marketplace. 'free' for b1dz first-party; authors set 'subscription' or 'revshare' later. */
  pricing: { model: 'free' } | { model: 'subscription'; usdPerMonth: number } | { model: 'revshare'; bps: number };
  /** Optional marketing tagline shown in the catalog card. */
  tagline?: string;
}

const V = '0.3.10';

export const PLUGIN_CATALOG: CatalogEntry[] = [
  // ── Strategies ──────────────────────────────────────────────────────────
  {
    status: 'ready',
    pricing: { model: 'free' },
    tagline: 'Automated cross-exchange arbitrage across Kraken, Binance.US, Coinbase, and Gemini.',
    manifest: {
      id: 'cex-arb',
      kind: 'strategy',
      version: V,
      name: 'CEX Arbitrage',
      author: 'b1dz',
      description: 'Detects price discrepancies across Kraken, Binance.US, Coinbase Advanced Trade, and Gemini. Places simultaneous buy/sell orders to capture the spread. Includes an auto-seeder and seed-funding liquidator for inventory management.',
      capabilities: ['style:arbitrage', 'venue:kraken', 'venue:binance-us', 'venue:coinbase', 'venue:gemini', 'timeframe:tick'],
    },
  },
  {
    status: 'ready',
    pricing: { model: 'free' },
    tagline: 'Multi-pair signal-based trading with integrated DEX execution.',
    manifest: {
      id: 'signal-trade',
      kind: 'strategy',
      version: V,
      name: 'Signal Trader',
      author: 'b1dz',
      description: 'OHLC-based indicator engine (RSI, Bollinger, MACD) generating buy/sell signals across CEX pairs. Integrates with DEX connectors for on-chain execution. Includes daily loss limit circuit breaker.',
      capabilities: ['style:signal', 'style:indicator', 'timeframe:ohlc', 'circuit-breaker'],
    },
  },
  {
    status: 'ready',
    pricing: { model: 'free' },
    tagline: 'Passive dollar-cost averaging across all four CEX venues.',
    manifest: {
      id: 'dca',
      kind: 'strategy',
      version: V,
      name: 'DCA — Dollar-Cost Averaging',
      author: 'b1dz',
      description: 'Allocates a configurable percentage of account equity as periodic buys across BTC, ETH, SOL, and other configured assets. Spreads purchases across Kraken, Binance.US, Coinbase, and Gemini to minimize venue risk.',
      capabilities: ['style:dca', 'venue:kraken', 'venue:binance-us', 'venue:coinbase', 'venue:gemini', 'timeframe:periodic'],
    },
  },
  {
    status: 'ready',
    pricing: { model: 'free' },
    tagline: 'Multi-venue cross-DEX arbitrage with triangular path detection.',
    manifest: {
      id: 'v2-pipeline',
      kind: 'strategy',
      version: V,
      name: 'V2 Arb Pipeline',
      author: 'b1dz',
      description: 'Observer + trade-daemon pipeline that surfaces cross-venue opportunities across CEX and DEX adapters. Supports paper, observe, and live modes. Triangular engine finds 3-hop Base paths. Circuit breaker with configurable trip thresholds.',
      capabilities: ['style:arbitrage', 'style:triangular', 'venue:all-cex', 'venue:uniswap-v3', 'venue:1inch', 'venue:jupiter', 'circuit-breaker'],
    },
  },
  {
    status: 'preview',
    pricing: { model: 'free' },
    tagline: 'Buy signal when the last three bid ticks are strictly rising.',
    manifest: {
      id: 'momentum',
      kind: 'strategy',
      version: '0.1.0',
      name: 'Momentum (3-tick rising)',
      author: 'b1dz',
      description: 'Reference momentum strategy. Fires a buy signal on 3 consecutive rising bid ticks. Useful as a template for building custom tick-based strategies.',
      capabilities: ['style:momentum', 'timeframe:tick'],
    },
  },

  // ── CEX Connectors ───────────────────────────────────────────────────────
  {
    status: 'ready',
    pricing: { model: 'free' },
    tagline: 'Spot and advanced trading on Coinbase Advanced Trade (US).',
    manifest: {
      id: 'coinbase',
      kind: 'connector',
      version: V,
      name: 'Coinbase Advanced Trade',
      author: 'b1dz',
      description: 'Full-featured connector for Coinbase Advanced Trade REST and WebSocket APIs. Supports order placement, balance queries, and live feed subscriptions. Requires API key name + EC private key (PEM).',
      capabilities: ['venue:coinbase', 'market:spot', 'feed:websocket', 'auth:api-key'],
    },
  },
  {
    status: 'ready',
    pricing: { model: 'free' },
    tagline: 'Spot trading on Kraken with full order book and trade history.',
    manifest: {
      id: 'kraken',
      kind: 'connector',
      version: V,
      name: 'Kraken',
      author: 'b1dz',
      description: 'REST and WebSocket connector for Kraken Pro. Supports spot order placement, ledger queries, open/closed order tracking, and live ticker subscriptions. Requires API key + base64 secret.',
      capabilities: ['venue:kraken', 'market:spot', 'feed:websocket', 'auth:api-key'],
    },
  },
  {
    status: 'ready',
    pricing: { model: 'free' },
    tagline: 'US-compliant spot trading on Binance.US.',
    manifest: {
      id: 'binance-us',
      kind: 'connector',
      version: V,
      name: 'Binance.US',
      author: 'b1dz',
      description: 'Connector for Binance.US REST API. Covers account balance, spot order placement (limit/market/IOC), and order book snapshots. Pair format matches Binance.US conventions (BTCUSDT etc.).',
      capabilities: ['venue:binance-us', 'market:spot', 'auth:api-key'],
    },
  },
  {
    status: 'ready',
    pricing: { model: 'free' },
    tagline: 'Spot and sub-account trading on Gemini Exchange.',
    manifest: {
      id: 'gemini',
      kind: 'connector',
      version: V,
      name: 'Gemini',
      author: 'b1dz',
      description: 'REST connector for Gemini Exchange. Supports primary, master, and sub-account keys. Order placement, balance queries, and nonce-offset management for multi-client setups.',
      capabilities: ['venue:gemini', 'market:spot', 'auth:api-key', 'feature:sub-accounts'],
    },
  },

  // ── DEX Connectors ───────────────────────────────────────────────────────
  {
    status: 'ready',
    pricing: { model: 'free' },
    tagline: 'Execute swaps on Base through Uniswap V3.',
    manifest: {
      id: 'uniswap-v3-base',
      kind: 'connector',
      version: V,
      name: 'Uniswap V3 — Base',
      author: 'b1dz',
      description: 'Single-venue connector for Uniswap V3 on Base. Wraps SwapRouter02. Signs with EVM hot wallet. Gated by DEX_TRADE_EXECUTION and DEX_TRADE_MAX_USD.',
      capabilities: ['chain:base', 'venue:uniswap-v3', 'signer:evm'],
    },
  },
  {
    status: 'ready',
    pricing: { model: 'free' },
    tagline: 'Best-price EVM swaps via the 1inch aggregation router.',
    manifest: {
      id: '1inch',
      kind: 'connector',
      version: V,
      name: '1inch — Base / EVM',
      author: 'b1dz',
      description: 'DEX aggregator connector for 1inch on Base (and other EVM chains). Routes through hundreds of liquidity sources for optimal swap prices. Requires 1inch API key and EVM hot wallet.',
      capabilities: ['chain:base', 'chain:evm', 'venue:1inch', 'signer:evm'],
    },
  },
  {
    status: 'ready',
    pricing: { model: 'free' },
    tagline: 'Solana swaps via Jupiter aggregator.',
    manifest: {
      id: 'jupiter',
      kind: 'connector',
      version: V,
      name: 'Jupiter — Solana',
      author: 'b1dz',
      description: 'Single-venue connector for the Jupiter aggregator on Solana. Best-price routing across all Solana DEXes. Requires Solana hot wallet private key.',
      capabilities: ['chain:solana', 'venue:jupiter', 'signer:solana'],
    },
  },
  {
    status: 'preview',
    pricing: { model: 'free' },
    tagline: 'Discover and monitor pump.fun token launches on Solana.',
    manifest: {
      id: 'pumpfun',
      kind: 'connector',
      version: V,
      name: 'pump.fun — Solana',
      author: 'b1dz',
      description: 'Discovery and lifecycle adapter for pump.fun token launches. Classifies tokens by lifecycle stage (bonding/graduated/migrated). Feed-only in preview — execution support coming in v1.',
      capabilities: ['chain:solana', 'venue:pump.fun', 'feature:discovery'],
    },
  },
  {
    status: 'preview',
    pricing: { model: 'free' },
    tagline: 'EVM DEX liquidity via the 0x Protocol API.',
    manifest: {
      id: '0x',
      kind: 'connector',
      version: '0.1.0',
      name: '0x Protocol — EVM',
      author: 'b1dz',
      description: 'Price discovery and swap routing via the 0x/Matcha aggregator. Supports Base, Ethereum, and other EVM chains. Requires ZEROX_API_KEY.',
      capabilities: ['chain:base', 'chain:evm', 'venue:0x', 'signer:evm'],
    },
  },
];

export function listCatalog(kind?: PluginManifest['kind']): CatalogEntry[] {
  if (!kind) return PLUGIN_CATALOG;
  return PLUGIN_CATALOG.filter((e) => e.manifest.kind === kind);
}
