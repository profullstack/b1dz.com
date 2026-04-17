/**
 * Canonical quote and opportunity types shared by every venue adapter
 * (CEX, EVM DEX/aggregator, Solana DEX/aggregator, Pump.fun launchpad).
 *
 * See PRD.md §13 for the authoritative spec.
 *
 * Design notes:
 * - Numeric fields that represent on-wire amounts are strings (decimal
 *   notation) to avoid float precision loss. USD estimates can stay
 *   numeric since they're just for thresholding and display.
 * - `chain` is null for CEX venues. For onchain venues it's a short
 *   slug like "base", "ethereum", "solana", "avalanche".
 * - `raw` holds the adapter's untouched response so debugging, replay,
 *   and deeper analysis don't require re-querying the venue.
 */

export type VenueType = 'cex' | 'dex' | 'aggregator' | 'launchpad';

export type TokenLifecycle =
  | 'new_launch'
  | 'bonding_curve'
  | 'migrating'
  | 'pumpswap'
  | 'external_pool';

export type OpportunityCategory =
  | 'cex_cex'
  | 'cex_dex'
  | 'dex_dex'
  | 'dex_triangular'
  | 'pumpfun_scalp'
  | 'pumpfun_migration'
  | 'pumpfun_post_migration';

/** Describes a triangular (single-venue, multi-hop cyclic) arbitrage
 *  route. Present on Opportunity iff `category === 'dex_triangular'`.
 *
 *  The route always starts and ends in the same anchor token (MVP: USDC)
 *  and passes through two intermediate assets via the named DEX venue.
 *  Execution is atomic — one tx, revert-protects with `amountOutMinimum`
 *  computed from the quoted `amountOut` and `slippageBps`. */
export interface TriangularRoute {
  /** Chain slug, e.g. "base". */
  chain: string;
  /** DEX venue, e.g. "uniswap-v3". */
  venue: string;
  /** Ordered hops — length 3 for a triangle. */
  hops: Array<{
    tokenIn: string;   // symbol
    tokenOut: string;  // symbol
    /** Fee tier in hundredths of a bp (Uniswap-V3 convention: 500 = 0.05%). */
    fee: number;
  }>;
  /** Decimal amount of the anchor token spent. */
  amountIn: string;
  /** Decimal amount of the anchor token received after all hops. */
  amountOut: string;
  /** 0x-prefixed hex — the encoded path bytes for SwapRouter02 `exactInput`. */
  path: string;
}

/** PRD Addendum A: execution mode the operator / infra can support.
 *  An opportunity whose recommendedExecutionMode exceeds the available
 *  mode must be rejected or paper-only. */
export type ExecutionMode = 'public' | 'private' | 'bundle' | 'paper_only';

/** PRD §A6 — realizability metadata attached to every Opportunity so
 *  the daemon can refuse routes that look profitable in a frictionless
 *  model but would not survive live execution. */
export interface OpportunityExecutionMeta {
  /** 0-1. 1 = very likely to execute at or near quoted edge. */
  realizabilityScore: number;
  /** 0-1. Higher = more backrun/sandwich exposure on public mempool. */
  mevRiskScore: number;
  /** 0-1. Higher = detection-to-submit window is the primary risk. */
  latencyRiskScore: number;
  requiresPrivateFlow: boolean;
  recommendedExecutionMode: ExecutionMode;
  simulationNotes: string[];
}

export interface NormalizedQuote {
  venue: string;
  venueType: VenueType;
  chain: string | null;
  dexProtocol?: string | null;
  pair: string;
  baseAsset: string;
  quoteAsset: string;
  /** Decimal string in base units (e.g. "1.25" ETH, "500" USDC). */
  amountIn: string;
  amountOut: string;
  amountInUsd?: number | null;
  amountOutUsd?: number | null;
  side: 'buy' | 'sell';
  /** Effective unit price (quote per base). Decimal string. */
  estimatedUnitPrice: string;
  /** All-in trading / protocol fees in USD. */
  feeUsd: number;
  /** Execution gas cost in USD. 0 for CEX quotes. */
  gasUsd: number;
  /** Expected slippage in basis points (1 bp = 0.01%). */
  slippageBps: number;
  priceImpactBps?: number | null;
  routeHops: number;
  routeSummary: string[];
  quoteTimestamp: number;
  expiresAt?: number | null;
  latencyMs?: number | null;
  allowanceRequired?: boolean | null;
  approvalToken?: string | null;
  tokenLifecycle?: TokenLifecycle | null;
  raw: unknown;
}

export interface Opportunity {
  id: string;
  buyVenue: string;
  sellVenue: string;
  buyChain: string | null;
  sellChain: string | null;
  asset: string;
  /** Position size in USD. Decimal string to preserve precision. */
  size: string;
  grossEdgeUsd: number;
  totalFeesUsd: number;
  totalGasUsd: number;
  totalSlippageUsd: number;
  riskBufferUsd: number;
  expectedNetUsd: number;
  expectedNetBps: number;
  /** 0-1 confidence score from the adapter / ranker. */
  confidence: number;
  blockers: string[];
  executable: boolean;
  category: OpportunityCategory;
  /** References to the underlying quotes for audit. */
  buyQuote: NormalizedQuote;
  sellQuote: NormalizedQuote;
  /** When this opportunity was scored (ms since epoch). */
  observedAt: number;
  /** PRD §A6: realizability / MEV / execution-mode metadata. Optional
   *  for legacy callers; observer should always populate it via
   *  scoreExecutionMeta() before publishing to the channel. */
  execution?: OpportunityExecutionMeta | null;
  /** Multi-hop cyclic route. Present iff `category === 'dex_triangular'`. */
  route?: TriangularRoute | null;
}

// ─── Adapter interface ────────────────────────────────────────────

export interface QuoteRequest {
  /** Canonical pair, e.g. "ETH-USDC". */
  pair: string;
  /** 'buy' means spend quote to get base; 'sell' means spend base to get quote. */
  side: 'buy' | 'sell';
  /** Amount in the input asset as a decimal string. */
  amountIn: string;
  /** Optional chain hint for multi-chain venues. */
  chain?: string;
  /** Optional max slippage in bps the adapter should quote for. */
  maxSlippageBps?: number;
}

export type AdapterHealth =
  | { ok: true; latencyMs: number }
  | { ok: false; reason: string };

export interface VenueAdapter {
  readonly venue: string;
  readonly venueType: VenueType;
  /** null for multi-chain adapters, a specific slug for chain-bound ones. */
  readonly chain: string | null;

  /** Cheap liveness probe; must not place real orders. */
  health(): Promise<AdapterHealth>;

  /** Whether this adapter can produce a quote for the requested pair/chain. */
  supports(req: QuoteRequest): Promise<boolean>;

  /** Fetch a normalized quote for the request. Returns null if unsupported
   *  at request time (e.g. pair not listed, liquidity too low). */
  quote(req: QuoteRequest): Promise<NormalizedQuote | null>;
}

// ─── Opportunity construction helper ──────────────────────────────

export interface ProfitabilityConfig {
  /** Additional USD buffer beyond raw fees/gas/slippage to guard against
   *  quote staleness and execution surprise. */
  riskBufferUsd?: number;
}

/** Chains where public-mempool arbitrage is effectively owned by
 *  professional MEV infrastructure. Public-mode routes here should be
 *  treated with extra skepticism per PRD §A9. */
const HIGH_MEV_CHAINS = new Set(['ethereum', 'mainnet']);

/**
 * Heuristic realizability scorer (PRD §A3, §A6).
 *
 * MVP-grade: good enough to gate the obvious cases while a proper
 * simulator is built out. A route is downgraded toward private/bundle
 * when both legs are DEX on a high-MEV chain, and toward paper_only
 * when a Pump.fun launch lacks a validated exit.
 */
export function scoreExecutionMeta(
  buy: NormalizedQuote,
  sell: NormalizedQuote,
  category: OpportunityCategory,
): OpportunityExecutionMeta {
  const notes: string[] = [];
  let realizability = 0.9;
  let mev = 0.1;
  let latency = 0.1;
  let mode: ExecutionMode = 'public';
  let requiresPrivate = false;

  const bothDex = buy.venueType !== 'cex' && sell.venueType !== 'cex';
  const buyHighMev = buy.chain ? HIGH_MEV_CHAINS.has(buy.chain) : false;
  const sellHighMev = sell.chain ? HIGH_MEV_CHAINS.has(sell.chain) : false;

  if (category === 'dex_triangular') {
    // Atomic single-tx cyclic swap: all hops succeed or the tx reverts,
    // so backrun/sandwich windows between legs don't exist. MEV risk is
    // just whether someone sees the pending tx and front-runs one hop —
    // on Base that's low. Realizability is bounded by `amountOutMinimum`
    // slippage; if it's set sensibly, quoted edge translates directly.
    mev = buyHighMev ? 0.35 : 0.15;
    latency = 0.1;
    realizability = buyHighMev ? 0.55 : 0.8;
    notes.push('dex triangular (atomic) — single-tx cyclic swap');
  } else if (bothDex && (buyHighMev || sellHighMev)) {
    // PRD §A9: don't try to win public-mempool races against pro MEV.
    mev = 0.85;
    realizability = 0.35;
    requiresPrivate = true;
    mode = 'private';
    notes.push('dex↔dex on high-MEV chain — public mempool likely to lose edge');
  } else if (bothDex) {
    // L2s / altchains: public OK but still some MEV risk.
    mev = 0.4;
    realizability = 0.7;
    notes.push('dex↔dex on lower-MEV chain — public execution acceptable');
  } else if (buy.venueType === 'cex' && sell.venueType === 'cex') {
    // CEX↔CEX has no mempool exposure; realizability is gated by
    // withdrawal/transfer rather than MEV.
    mev = 0.05;
    latency = 0.2;
    realizability = 0.85;
    notes.push('cex↔cex — no mempool MEV risk');
  } else {
    // Mixed CEX/DEX: one leg is onchain, still exposed to MEV on that leg.
    mev = (buyHighMev || sellHighMev) ? 0.6 : 0.3;
    realizability = (buyHighMev || sellHighMev) ? 0.55 : 0.75;
    if (buyHighMev || sellHighMev) {
      requiresPrivate = true;
      mode = 'private';
      notes.push('cex↔dex with a high-MEV chain leg — prefer private flow');
    }
  }

  // Pump.fun categories: default to paper_only unless the lifecycle
  // is post-migration with a known external pool.
  if (category === 'pumpfun_scalp' || category === 'pumpfun_migration') {
    mode = 'paper_only';
    realizability = Math.min(realizability, 0.4);
    notes.push('pump.fun pre-migration — paper only until exit route validated');
  }

  // Staleness pressure: if either quote is already expired at scoring
  // time, the route is not realistic.
  const now = Date.now();
  if ((buy.expiresAt && buy.expiresAt <= now) || (sell.expiresAt && sell.expiresAt <= now)) {
    realizability = 0.05;
    latency = 0.95;
    notes.push('one or both quotes expired');
  }

  // Many hops on DEX legs compound slippage + latency surprise.
  const maxHops = Math.max(buy.routeHops, sell.routeHops);
  if (maxHops >= 3) {
    realizability = Math.max(0, realizability - 0.2);
    latency = Math.min(1, latency + 0.2);
    notes.push(`route complexity: ${maxHops} hops`);
  }

  return {
    realizabilityScore: Math.max(0, Math.min(1, realizability)),
    mevRiskScore: Math.max(0, Math.min(1, mev)),
    latencyRiskScore: Math.max(0, Math.min(1, latency)),
    requiresPrivateFlow: requiresPrivate,
    recommendedExecutionMode: mode,
    simulationNotes: notes,
  };
}

export function buildOpportunity(
  id: string,
  sizeUsd: string,
  buy: NormalizedQuote,
  sell: NormalizedQuote,
  category: OpportunityCategory,
  cfg: ProfitabilityConfig = {},
): Opportunity {
  const grossEdgeUsd = (sell.amountOutUsd ?? 0) - (buy.amountInUsd ?? 0);
  const totalFeesUsd = buy.feeUsd + sell.feeUsd;
  const totalGasUsd = buy.gasUsd + sell.gasUsd;
  const totalSlippageUsd = ((buy.slippageBps + sell.slippageBps) / 10_000) * Number.parseFloat(sizeUsd);
  const riskBufferUsd = cfg.riskBufferUsd ?? 0;
  const expectedNetUsd = grossEdgeUsd - totalFeesUsd - totalGasUsd - totalSlippageUsd - riskBufferUsd;
  const expectedNetBps = Number.parseFloat(sizeUsd) > 0
    ? (expectedNetUsd / Number.parseFloat(sizeUsd)) * 10_000
    : 0;

  const blockers: string[] = [];
  if (grossEdgeUsd <= 0) blockers.push('negative gross edge');
  if (expectedNetUsd <= 0) blockers.push('negative net after costs');

  return {
    id,
    buyVenue: buy.venue,
    sellVenue: sell.venue,
    buyChain: buy.chain,
    sellChain: sell.chain,
    asset: buy.baseAsset,
    size: sizeUsd,
    grossEdgeUsd,
    totalFeesUsd,
    totalGasUsd,
    totalSlippageUsd,
    riskBufferUsd,
    expectedNetUsd,
    expectedNetBps,
    confidence: Math.min(1, Math.max(0, expectedNetBps / 100)),
    blockers,
    executable: blockers.length === 0,
    category,
    buyQuote: buy,
    sellQuote: sell,
    observedAt: Date.now(),
    execution: scoreExecutionMeta(buy, sell, category),
  };
}

// ─── Triangular opportunity helper ────────────────────────────────

export interface BuildTriangularArgs {
  id: string;
  /** Decimal USD size of the anchor input. */
  sizeUsd: string;
  /** Fully priced route — `amountOut` already reflects all pool fees. */
  route: TriangularRoute;
  /** USD value of `route.amountIn` and `route.amountOut` in the anchor
   *  asset. For a stablecoin anchor these are just the decimal amounts. */
  amountInUsd: number;
  amountOutUsd: number;
  /** Total gas cost of the single atomic tx in USD. */
  gasUsd: number;
  /** Additional slippage buffer in bps applied across all hops. Default 150
   *  (≈ 50 bps × 3 hops). */
  slippageBps?: number;
  /** Optional additional riskBuffer USD on top of gas + slippage. */
  riskBufferUsd?: number;
}

/** Build an Opportunity for a triangular (single-venue cyclic) route.
 *
 *  Unlike `buildOpportunity()`, there is no pairwise buy/sell venue split;
 *  the whole cycle runs on one venue. To keep the wire shape uniform for
 *  the channel, TUI, and daemon, we synthesize minimal buy/sell quotes
 *  from the first and last hop — real data lives on the `route` field.
 */
export function buildTriangularOpportunity(args: BuildTriangularArgs): Opportunity {
  const { id, sizeUsd, route, amountInUsd, amountOutUsd, gasUsd } = args;
  const slippageBps = args.slippageBps ?? 150;
  const riskBufferUsd = args.riskBufferUsd ?? 0;

  const grossEdgeUsd = amountOutUsd - amountInUsd;
  const totalSlippageUsd = (slippageBps / 10_000) * Number.parseFloat(sizeUsd);
  const expectedNetUsd = grossEdgeUsd - gasUsd - totalSlippageUsd - riskBufferUsd;
  const sizeNum = Number.parseFloat(sizeUsd);
  const expectedNetBps = sizeNum > 0 ? (expectedNetUsd / sizeNum) * 10_000 : 0;

  const blockers: string[] = [];
  if (grossEdgeUsd <= 0) blockers.push('negative gross edge');
  if (expectedNetUsd <= 0) blockers.push('negative net after costs');

  const now = Date.now();
  const first = route.hops[0];
  const last = route.hops[route.hops.length - 1];
  const anchor = route.hops[0].tokenIn;

  // Synthetic quotes — shaped like the adapter's real NormalizedQuote so
  // downstream code (TUI, daemon metrics) doesn't need to branch. The
  // `route` field is the canonical source of truth for the triangle.
  const buyQuote: NormalizedQuote = {
    venue: route.venue,
    venueType: 'dex',
    chain: route.chain,
    dexProtocol: route.venue,
    pair: `${first.tokenOut}-${first.tokenIn}`,
    baseAsset: first.tokenOut,
    quoteAsset: first.tokenIn,
    amountIn: route.amountIn,
    amountOut: route.amountIn, // placeholder — first-hop amountOut not tracked separately
    amountInUsd,
    amountOutUsd: amountInUsd,
    side: 'buy',
    estimatedUnitPrice: '0',
    feeUsd: 0,
    gasUsd,
    slippageBps,
    priceImpactBps: null,
    routeHops: route.hops.length,
    routeSummary: route.hops.map((h) => `${h.tokenIn}→${h.tokenOut}@${h.fee}`),
    quoteTimestamp: now,
    expiresAt: null,
    latencyMs: null,
    allowanceRequired: true,
    approvalToken: null,
    tokenLifecycle: null,
    raw: { path: route.path, hops: route.hops },
  };
  const sellQuote: NormalizedQuote = {
    ...buyQuote,
    pair: `${last.tokenIn}-${last.tokenOut}`,
    baseAsset: last.tokenIn,
    quoteAsset: last.tokenOut,
    amountIn: route.amountIn,
    amountOut: route.amountOut,
    amountInUsd,
    amountOutUsd,
    side: 'sell',
    gasUsd: 0, // gas is on the single tx, not per synthetic leg
  };

  return {
    id,
    buyVenue: route.venue,
    sellVenue: route.venue,
    buyChain: route.chain,
    sellChain: route.chain,
    asset: anchor,
    size: sizeUsd,
    grossEdgeUsd,
    totalFeesUsd: 0, // pool fees already baked into amountOut
    totalGasUsd: gasUsd,
    totalSlippageUsd,
    riskBufferUsd,
    expectedNetUsd,
    expectedNetBps,
    confidence: Math.min(1, Math.max(0, expectedNetBps / 100)),
    blockers,
    executable: blockers.length === 0,
    category: 'dex_triangular',
    buyQuote,
    sellQuote,
    observedAt: now,
    execution: scoreExecutionMeta(buyQuote, sellQuote, 'dex_triangular'),
    route,
  };
}
