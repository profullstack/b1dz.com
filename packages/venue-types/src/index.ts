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
  | 'pumpfun_scalp'
  | 'pumpfun_migration'
  | 'pumpfun_post_migration';

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
  };
}
