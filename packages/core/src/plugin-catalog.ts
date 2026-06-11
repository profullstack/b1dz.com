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
import {
  configSchemaFromFieldSpec,
  type CatalogEntry,
  type PluginFieldSpec,
  type PluginManifest,
} from '@profullstack/pluginstore';

export type { CatalogEntry } from '@profullstack/pluginstore';

const V = '0.3.10';

const PLUGIN_CONFIG_SCHEMAS = Object.fromEntries(
  Object.entries({
    coinbase: {
      strings: [{ key: 'COINBASE_API_KEY_NAME', label: 'API key name', hint: 'organizations/.../apiKeys/...' }],
      secrets: [
        { key: 'COINBASE_API_PRIVATE_KEY', label: 'EC private key (PEM)', multiline: true, hint: '-----BEGIN EC PRIVATE KEY----- block' },
        { key: 'COINBASE_API_PRIVATE_KEY_B', label: 'EC private key B (PEM, optional)', multiline: true, hint: 'Second account key' },
        { key: 'COINBASE_EC_KEY_B', label: 'EC key B legacy (PEM, optional)', multiline: true, hint: 'Legacy secondary key' },
      ],
    },
    kraken: {
      secrets: [
        { key: 'KRAKEN_API_KEY', label: 'API key' },
        { key: 'KRAKEN_API_SECRET', label: 'API secret' },
      ],
    },
    'binance-us': {
      secrets: [
        { key: 'BINANCE_US_API_KEY', label: 'API key' },
        { key: 'BINANCE_US_API_SECRET', label: 'API secret' },
      ],
    },
    gemini: {
      strings: [{ key: 'GEMINI_ACCOUNT', label: 'Account name', hint: 'primary / master / sub-label' }],
      secrets: [
        { key: 'GEMINI_API_KEY', label: 'API key' },
        { key: 'GEMINI_API_SECRET', label: 'API secret' },
      ],
    },
    'uniswap-v3-base': {
      secrets: [{ key: 'EVM_PRIVATE_KEY', label: 'EVM hot wallet private key', hint: '0x... 64-hex' }],
      strings: [{ key: 'BASE_RPC_URL', label: 'Base RPC URL' }],
      numbers: [
        { key: 'DEX_TRADE_MAX_USD', label: 'Max trade USD', hint: 'Hard ceiling per swap, e.g. 20' },
        { key: 'DEX_SLIPPAGE_BPS', label: 'Slippage (bps)', hint: '300 = 3%' },
      ],
    },
    '1inch': {
      secrets: [
        { key: 'ONEINCH_API_KEY', label: '1inch API key' },
        { key: 'EVM_PRIVATE_KEY', label: 'EVM hot wallet private key', hint: '0x... 64-hex' },
      ],
    },
    pumpfun: {
      bools: [{ key: 'PUMPFUN_ENABLE_SCRAPE', label: 'Enable scraper' }],
    },
    '0x': {
      secrets: [{ key: 'ZEROX_API_KEY', label: '0x API key' }],
    },
    'cex-arb': {
      strings: [{ key: 'ARB_MODE', label: 'Mode', hint: 'observe | paper | live' }],
      numbers: [
        { key: 'ARB_MAX_TRADE_USD', label: 'Max trade USD', hint: 'Per-leg cap, e.g. 15' },
        { key: 'ARB_SIZE_USD', label: 'Notional size USD' },
        { key: 'ARB_MIN_NET_USD', label: 'Min net profit USD', hint: 'e.g. 0.01' },
        { key: 'ARB_MIN_NET_BPS', label: 'Min net profit bps', hint: 'e.g. 3 (= 0.03%)' },
      ],
      bools: [
        { key: 'ARB_EXECUTOR_UNISWAP_BASE', label: 'Arm Uniswap V3 executor' },
        { key: 'ARB_TRIANGULAR', label: 'Triangular arb scanner' },
        { key: 'MARGIN_TRADING', label: 'Margin trading' },
      ],
    },
    dca: {
      bools: [{ key: 'DCA_ENABLED', label: 'DCA enabled' }],
      strings: [
        { key: 'DCA_COINS', label: 'Coins', hint: 'BTC,ETH,SOL' },
        { key: 'DCA_EXCHANGES', label: 'Exchanges', hint: 'kraken,coinbase,binance-us,gemini' },
      ],
      numbers: [
        { key: 'DCA_TOTAL_ALLOCATION_PCT', label: 'Allocation %', hint: '% of equity, e.g. 10' },
        { key: 'DCA_MAX_COINS', label: 'Max coins', hint: 'e.g. 3' },
        { key: 'DCA_INTERVAL_MS', label: 'Interval ms', hint: '86400000 = 24h' },
      ],
    },
    'v2-pipeline': {
      strings: [{ key: 'V2_MODE', label: 'Mode', hint: 'observe | paper | live' }],
      numbers: [
        { key: 'V2_SIZE_USD', label: 'Notional size USD' },
        { key: 'V2_MAX_PAIRS', label: 'Max pairs', hint: 'e.g. 10' },
        { key: 'V2_MAX_TRADE_USD', label: 'Max trade USD' },
        { key: 'V2_MIN_NET_USD', label: 'Min net profit USD', hint: 'e.g. 0.10' },
      ],
    },
    'signal-trade': {
      numbers: [
        { key: 'ENTRY_MIN_SCORE', label: 'Min entry score', hint: '0-1, e.g. 0.6' },
        { key: 'MIN_HOLD_SECS', label: 'Min hold (secs)', hint: 'e.g. 300' },
        { key: 'MIN_VOLUME_USD', label: 'Min volume USD', hint: 'Pair must clear this threshold' },
      ],
      bools: [{ key: 'REQUIRE_CONFIRM_UPTREND', label: 'Require uptrend confirmation' }],
    },
    momentum: {
      numbers: [
        { key: 'ENTRY_MIN_SCORE', label: 'Min entry score', hint: '0-1' },
        { key: 'MIN_HOLD_SECS', label: 'Min hold (secs)' },
      ],
      bools: [{ key: 'REQUIRE_CONFIRM_UPTREND', label: 'Require uptrend confirmation' }],
    },
    alpaca: {
      secrets: [
        { key: 'ALPACA_API_KEY_ID', label: 'API key ID' },
        { key: 'ALPACA_API_SECRET_KEY', label: 'API secret key' },
      ],
      bools: [{ key: 'ALPACA_PAPER', label: 'Paper trading', hint: 'Leave on until live equity execution is enabled' }],
      strings: [{ key: 'ALPACA_FEED', label: 'Market-data feed', hint: 'iex (free) | sip (subscription)' }],
    },
    tradier: {
      secrets: [{ key: 'TRADIER_ACCESS_TOKEN', label: 'Access token' }],
      strings: [{ key: 'TRADIER_ACCOUNT_ID', label: 'Account ID' }],
      bools: [{ key: 'TRADIER_SANDBOX', label: 'Sandbox (paper)', hint: 'Use the sandbox host' }],
    },
    ibkr: {
      secrets: [{ key: 'IBKR_ACCESS_TOKEN', label: 'OAuth token (optional)', hint: 'Only for OAuth gateways' }],
      strings: [
        { key: 'IBKR_BASE_URL', label: 'Gateway base URL', hint: 'e.g. https://localhost:5000/v1/api' },
        { key: 'IBKR_ACCOUNT_ID', label: 'Account ID', hint: 'e.g. U1234567 (optional — auto-resolved)' },
      ],
    },
    schwab: {
      secrets: [{ key: 'SCHWAB_ACCESS_TOKEN', label: 'OAuth access token' }],
      strings: [{ key: 'SCHWAB_ACCOUNT_HASH', label: 'Account hash' }],
    },
    tradestation: {
      secrets: [{ key: 'TRADESTATION_ACCESS_TOKEN', label: 'OAuth access token' }],
      strings: [{ key: 'TRADESTATION_ACCOUNT_ID', label: 'Account ID' }],
      bools: [{ key: 'TRADESTATION_SIM', label: 'Simulated (paper)', hint: 'Use the sim host' }],
    },
    webull: {
      secrets: [{ key: 'WEBULL_ACCESS_TOKEN', label: 'Access token' }],
      strings: [
        { key: 'WEBULL_ACCOUNT_ID', label: 'Account ID' },
        { key: 'WEBULL_BASE_URL', label: 'Base URL (optional)', hint: 'Region OpenAPI host' },
      ],
      bools: [{ key: 'WEBULL_PAPER', label: 'Paper trading' }],
    },
  } satisfies Record<string, PluginFieldSpec>).map(([id, spec]) => [id, configSchemaFromFieldSpec(spec)]),
) as Record<string, ReturnType<typeof configSchemaFromFieldSpec>>;

export const PLUGIN_CATALOG: CatalogEntry[] = [
  // ── Strategies ──────────────────────────────────────────────────────────
  {
    status: 'ready',
    pricing: { model: 'free' },
    tagline: 'Automated cross-exchange arbitrage across Kraken, Binance.US, Coinbase, and Gemini.',
    config_schema: PLUGIN_CONFIG_SCHEMAS['cex-arb'],
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
    config_schema: PLUGIN_CONFIG_SCHEMAS['signal-trade'],
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
    config_schema: PLUGIN_CONFIG_SCHEMAS.dca,
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
    config_schema: PLUGIN_CONFIG_SCHEMAS['v2-pipeline'],
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
    config_schema: PLUGIN_CONFIG_SCHEMAS.momentum,
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
  // Asset-agnostic strategies (PRD equities-v1 §8) — run on crypto AND equities.
  {
    status: 'ready',
    pricing: { model: 'free' },
    tagline: 'Ride established trends across crypto and equities.',
    manifest: {
      id: 'trend-continuation',
      kind: 'strategy',
      version: '0.1.0',
      name: 'Trend Continuation',
      author: 'b1dz',
      description: 'Follows an established trend: long when the fast EMA leads the slow EMA with rising MACD momentum, short on the inverse. Signals-only; the engine applies session gating, sizing, and risk. Asset-agnostic — runs unchanged on crypto ticks and equity bars.',
      capabilities: ['style:trend', 'style:momentum', 'asset:crypto', 'asset:equity', 'timeframe:any'],
    },
  },
  {
    status: 'ready',
    pricing: { model: 'free' },
    tagline: 'Fade overbought/oversold extremes on any asset class.',
    manifest: {
      id: 'mean-reversion',
      kind: 'strategy',
      version: '0.1.0',
      name: 'Mean Reversion (RSI)',
      author: 'b1dz',
      description: 'Fades extremes: buys when RSI is oversold (<30), sells when overbought (>70). Signals-only. Asset-agnostic — works on crypto and equities.',
      capabilities: ['style:mean-reversion', 'indicator:rsi', 'asset:crypto', 'asset:equity', 'timeframe:any'],
    },
  },
  {
    status: 'ready',
    pricing: { model: 'free' },
    tagline: 'Trade range expansion — breakouts and breakdowns.',
    manifest: {
      id: 'breakout',
      kind: 'strategy',
      version: '0.1.0',
      name: 'Breakout / Breakdown',
      author: 'b1dz',
      description: 'Trades range expansion: buys a push above the prior N-bar high, sells a break below the prior N-bar low. Signals-only. Asset-agnostic — runs on crypto and equities.',
      capabilities: ['style:breakout', 'asset:crypto', 'asset:equity', 'timeframe:any'],
    },
  },

  // ── CEX Connectors ───────────────────────────────────────────────────────
  {
    status: 'ready',
    pricing: { model: 'free' },
    tagline: 'Spot and advanced trading on Coinbase Advanced Trade (US).',
    config_schema: PLUGIN_CONFIG_SCHEMAS.coinbase,
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
    config_schema: PLUGIN_CONFIG_SCHEMAS.kraken,
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
    config_schema: PLUGIN_CONFIG_SCHEMAS['binance-us'],
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
    config_schema: PLUGIN_CONFIG_SCHEMAS.gemini,
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
    config_schema: PLUGIN_CONFIG_SCHEMAS['uniswap-v3-base'],
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
    config_schema: PLUGIN_CONFIG_SCHEMAS['1inch'],
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
    config_schema: PLUGIN_CONFIG_SCHEMAS.pumpfun,
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
    config_schema: PLUGIN_CONFIG_SCHEMAS['0x'],
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
  // ── Equity Trading Connectors (PRD equities-v1) — first-party, free ────────
  // Listed with kind:'connector' (the pluginstore-compatible kind) and tagged
  // 'asset:equity' so the store groups them as "Equity Trading Connectors",
  // separate from DEX connectors. The runtime objects (@b1dz/source-*) implement
  // the core BrokerConnectorPlugin (kind:'broker'); these are display/config
  // records. Per-broker keys + paper toggle come from each config_schema; the
  // global equity engine settings live in the Equities settings tab.
  {
    status: 'ready',
    pricing: { model: 'free' },
    tagline: 'Global equities via Interactive Brokers — installed by default.',
    config_schema: PLUGIN_CONFIG_SCHEMAS.ibkr,
    config_notes: 'Requires a running IBKR Client Portal gateway; set the gateway base URL. No simple paper flag — use an IBKR paper account.',
    manifest: {
      id: 'ibkr',
      kind: 'connector',
      version: '0.1.0',
      name: 'Interactive Brokers — Global Equities',
      author: 'b1dz',
      description: 'US + international equities (LSE, TSE, XETRA, HKEX, TSX…) via the IBKR Client Portal Web API. Installed by default. Requires a running IBKR gateway session.',
      capabilities: ['asset:equity', 'venue:ibkr', 'broker:ibkr', 'market:us', 'market:intl', 'feature:fractional'],
    },
  },
  {
    status: 'ready',
    pricing: { model: 'free' },
    tagline: 'Commission-free US stocks & ETFs via Alpaca — paper-first.',
    config_schema: PLUGIN_CONFIG_SCHEMAS.alpaca,
    config_notes: 'Paper trading by default. Get keys at alpaca.markets → Paper Trading → API Keys.',
    manifest: {
      id: 'alpaca',
      kind: 'connector',
      version: '0.1.0',
      name: 'Alpaca — US Equities',
      author: 'b1dz',
      description: 'Commission-free US stocks & ETFs via Alpaca. Fractional/notional orders, IEX data (SIP via config), and a paper environment that mirrors live.',
      capabilities: ['asset:equity', 'venue:alpaca', 'broker:alpaca', 'market:us', 'data:iex', 'feature:fractional', 'feature:paper'],
    },
  },
  {
    status: 'ready',
    pricing: { model: 'free' },
    tagline: 'US stocks & ETFs via Tradier Brokerage.',
    config_schema: PLUGIN_CONFIG_SCHEMAS.tradier,
    manifest: {
      id: 'tradier',
      kind: 'connector',
      version: '0.1.0',
      name: 'Tradier — US Equities',
      author: 'b1dz',
      description: 'US stocks & ETFs via Tradier Brokerage. REST + streaming, OAuth, sandbox environment. Whole-share orders.',
      capabilities: ['asset:equity', 'venue:tradier', 'broker:tradier', 'market:us', 'feature:extended-hours', 'feature:paper'],
    },
  },
  {
    status: 'ready',
    pricing: { model: 'free' },
    tagline: 'US stocks & ETFs via Charles Schwab.',
    config_schema: PLUGIN_CONFIG_SCHEMAS.schwab,
    manifest: {
      id: 'schwab',
      kind: 'connector',
      version: '0.1.0',
      name: 'Charles Schwab — US Equities',
      author: 'b1dz',
      description: 'US stocks & ETFs via the Schwab Trader API. OAuth, ~120 req/min.',
      capabilities: ['asset:equity', 'venue:schwab', 'broker:schwab', 'market:us', 'data:sip'],
    },
  },
  {
    status: 'preview',
    pricing: { model: 'free' },
    tagline: 'US stocks & ETFs via TradeStation.',
    config_schema: PLUGIN_CONFIG_SCHEMAS.tradestation,
    manifest: {
      id: 'tradestation',
      kind: 'connector',
      version: '0.1.0',
      name: 'TradeStation — US Equities',
      author: 'b1dz',
      description: 'US stocks & ETFs via the TradeStation v3 API. OAuth, simulated-trading host.',
      capabilities: ['asset:equity', 'venue:tradestation', 'broker:tradestation', 'market:us', 'feature:paper'],
    },
  },
  {
    status: 'preview',
    pricing: { model: 'free' },
    tagline: 'US stocks & ETFs via Webull OpenAPI.',
    config_schema: PLUGIN_CONFIG_SCHEMAS.webull,
    manifest: {
      id: 'webull',
      kind: 'connector',
      version: '0.1.0',
      name: 'Webull — US Equities',
      author: 'b1dz',
      description: 'US stocks & ETFs via the Webull OpenAPI. Region-specific host; verify endpoints against the Webull developer portal.',
      capabilities: ['asset:equity', 'venue:webull', 'broker:webull', 'market:us', 'feature:paper'],
    },
  },
];

export function listCatalog(kind?: PluginManifest['kind']): CatalogEntry[] {
  if (!kind) return PLUGIN_CATALOG;
  return PLUGIN_CATALOG.filter((e) => e.manifest.kind === kind);
}
