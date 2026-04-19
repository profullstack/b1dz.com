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

export const PLUGIN_CATALOG: CatalogEntry[] = [
  {
    status: 'preview',
    pricing: { model: 'free' },
    tagline: 'Placeholder — will be replaced by real deterministic setups from the analysis engine.',
    manifest: {
      id: 'momentum',
      kind: 'strategy',
      version: '0.1.0',
      name: 'Momentum (3-tick rising)',
      author: 'b1dz',
      description: 'Fires a buy signal when the last three bid ticks are strictly rising. Reference implementation — do not trade real money against this.',
      capabilities: ['style:momentum', 'timeframe:tick'],
    },
  },
  {
    status: 'ready',
    pricing: { model: 'free' },
    tagline: 'Execute swaps on Base through Uniswap V3.',
    manifest: {
      id: 'uniswap-v3-base',
      kind: 'connector',
      version: '0.3.5',
      name: 'Uniswap V3 — Base',
      author: 'b1dz',
      description: 'Single-venue connector for Uniswap V3 on Base. Wraps SwapRouter02. Gated by DEX_TRADE_EXECUTION and DEX_TRADE_MAX_USD.',
      capabilities: ['chain:base', 'venue:uniswap-v3', 'signer:evm'],
    },
  },
  {
    status: 'ready',
    pricing: { model: 'free' },
    tagline: 'Solana swaps via Jupiter aggregator.',
    manifest: {
      id: 'jupiter',
      kind: 'connector',
      version: '0.3.5',
      name: 'Jupiter — Solana',
      author: 'b1dz',
      description: 'Single-venue connector for the Jupiter aggregator on Solana. Gated by DEX_TRADE_EXECUTION and DEX_TRADE_MAX_USD.',
      capabilities: ['chain:solana', 'venue:jupiter', 'signer:solana'],
    },
  },
];

export function listCatalog(kind?: PluginManifest['kind']): CatalogEntry[] {
  if (!kind) return PLUGIN_CATALOG;
  return PLUGIN_CATALOG.filter((e) => e.manifest.kind === kind);
}
