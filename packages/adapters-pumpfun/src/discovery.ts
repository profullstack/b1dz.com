/**
 * Pump.fun discovery adapter (PRD §6.4, §14.4, §17).
 *
 * Observe-only in MVP. Surfaces newly-created Pump.fun tokens so the
 * observer can score and (if later enabled) paper-trade them. We do NOT
 * place live orders here — execution against bonding-curve state or
 * PumpSwap requires a separate signed transaction flow that lands in
 * the guarded Pump.fun execution phase.
 *
 * Data source: the Pump.fun public frontend API is the least-bad option
 * today; it's unofficial so we require PUMPFUN_ENABLE_SCRAPE=true to
 * enable the client. PRD §27 mandates explicit opt-in for scrape
 * sources.
 */

import type {
  NormalizedQuote,
  QuoteRequest,
  VenueAdapter,
  AdapterHealth,
  TokenLifecycle,
} from '@b1dz/venue-types';
import { classifyLifecycle } from './lifecycle.js';

// Pump.fun rotates API hosts periodically. v3 is the active host at time
// of writing; older v1/v2 frontends return 530/503 for most clients.
// Override via PumpFunAdapterOptions.baseUrl when the upstream migrates.
const DEFAULT_BASE_URL = 'https://frontend-api-v3.pump.fun';

/** Raw upstream coin shape — only fields we consume. The upstream API
 *  returns many more fields; we deliberately narrow so schema drift in
 *  unused fields doesn't break the parser. */
export interface PumpFunRawCoin {
  mint: string;
  name: string;
  symbol: string;
  description?: string | null;
  image_uri?: string | null;
  creator?: string | null;
  created_timestamp: number;
  market_cap?: number | null;
  usd_market_cap?: number | null;
  reply_count?: number | null;
  virtual_sol_reserves?: number | null;
  virtual_token_reserves?: number | null;
  complete: boolean;
  raydium_pool?: string | null;
  pumpswap_pool?: string | null;
}

export interface PumpFunTokenCandidate {
  mint: string;
  name: string;
  symbol: string;
  creator: string | null;
  createdAtMs: number;
  marketCapUsd: number;
  lifecycle: TokenLifecycle;
  /** Virtual reserves (bonding curve state) for tokens still pre-migration.
   *  Null once graduated to Raydium/PumpSwap because the bonding curve is
   *  no longer the pricing mechanism. */
  virtualSolReserves: number | null;
  virtualTokenReserves: number | null;
  raydiumPool: string | null;
  pumpSwapPool: string | null;
  replyCount: number;
  /** Convenience flags the lifecycle classifier already encodes, exposed
   *  directly so consumers don't have to re-interpret the enum. */
  flags: {
    isNewLaunch: boolean;
    isBondingCurve: boolean;
    isMigrating: boolean;
    isGraduated: boolean;
  };
}

export interface PumpFunAdapterOptions {
  /** Required opt-in per PRD §27. Defaults to process.env.PUMPFUN_ENABLE_SCRAPE. */
  enableScrape?: boolean;
  /** Override for tests / self-hosted mirror. */
  baseUrl?: string;
  /** `fetch` injection for tests (default: global fetch). */
  fetchImpl?: typeof fetch;
  /** Clock injection for tests (default: Date.now). */
  now?: () => number;
  /** Max items to request per discovery call. Upstream supports up to 50. */
  pageLimit?: number;
}

export interface DiscoverOptions {
  /** Minimum USD market cap to include. Filters out dead-on-arrival tokens. */
  minMarketCapUsd?: number;
  /** Maximum age in minutes. Useful for "only brand-new launches". */
  maxAgeMinutes?: number;
  /** Filter by lifecycle state. Empty/undefined returns all states. */
  lifecycleAllowlist?: TokenLifecycle[];
}

function parseCoin(raw: PumpFunRawCoin, now: number): PumpFunTokenCandidate {
  const createdAtMs = Number(raw.created_timestamp) || 0;
  const lifecycle = classifyLifecycle({
    complete: !!raw.complete,
    raydiumPool: raw.raydium_pool ?? null,
    pumpSwapPool: raw.pumpswap_pool ?? null,
    createdAtMs,
    now,
  });
  const marketCapUsd = Number(raw.usd_market_cap ?? raw.market_cap ?? 0);
  return {
    mint: raw.mint,
    name: raw.name,
    symbol: raw.symbol,
    creator: raw.creator ?? null,
    createdAtMs,
    marketCapUsd: Number.isFinite(marketCapUsd) ? marketCapUsd : 0,
    lifecycle,
    virtualSolReserves: raw.virtual_sol_reserves != null ? Number(raw.virtual_sol_reserves) : null,
    virtualTokenReserves: raw.virtual_token_reserves != null ? Number(raw.virtual_token_reserves) : null,
    raydiumPool: raw.raydium_pool ?? null,
    pumpSwapPool: raw.pumpswap_pool ?? null,
    replyCount: Number(raw.reply_count ?? 0),
    flags: {
      isNewLaunch: lifecycle === 'new_launch',
      isBondingCurve: lifecycle === 'bonding_curve',
      isMigrating: lifecycle === 'migrating',
      isGraduated: lifecycle === 'external_pool' || lifecycle === 'pumpswap',
    },
  };
}

export class PumpFunDiscoveryAdapter implements VenueAdapter {
  readonly venue = 'pumpfun';
  readonly venueType = 'launchpad' as const;
  readonly chain = 'solana';
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly pageLimit: number;
  private readonly enabled: boolean;

  constructor(opts: PumpFunAdapterOptions = {}) {
    this.baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
    this.fetchImpl = opts.fetchImpl ?? ((globalThis as { fetch: typeof fetch }).fetch);
    this.now = opts.now ?? (() => Date.now());
    this.pageLimit = Math.max(1, Math.min(50, opts.pageLimit ?? 50));
    this.enabled = opts.enableScrape ?? process.env.PUMPFUN_ENABLE_SCRAPE === 'true';
  }

  async health(): Promise<AdapterHealth> {
    if (!this.enabled) return { ok: false, reason: 'PUMPFUN_ENABLE_SCRAPE=false' };
    const started = this.now();
    try {
      const coins = await this.fetchCoins(5);
      if (!Array.isArray(coins)) return { ok: false, reason: 'unexpected response shape' };
      return { ok: true, latencyMs: this.now() - started };
    } catch (e) {
      return { ok: false, reason: (e as Error).message.slice(0, 200) };
    }
  }

  /**
   * Pump.fun as a VenueAdapter can't meaningfully quote arbitrary pairs —
   * it only deals in SOL↔<pump-mint>. We return null for everything
   * here; consumers looking for a Pump.fun price should use `discover()`
   * and then route through Jupiter for post-graduation tokens.
   */
  async supports(): Promise<boolean> {
    return false;
  }

  async quote(_req: QuoteRequest): Promise<NormalizedQuote | null> {
    void _req;
    return null;
  }

  /**
   * Core discovery API: returns the most-recent N tokens filtered by
   * the provided predicates. Never throws — returns [] when disabled,
   * when the upstream is down, or when parsing fails.
   */
  async discover(opts: DiscoverOptions = {}): Promise<PumpFunTokenCandidate[]> {
    if (!this.enabled) return [];
    let coins: PumpFunRawCoin[];
    try {
      coins = await this.fetchCoins(this.pageLimit);
    } catch {
      return [];
    }
    if (!Array.isArray(coins)) return [];
    const now = this.now();
    const parsed = coins.map((c) => parseCoin(c, now));
    return parsed.filter((t) => this.passesFilter(t, opts, now));
  }

  private passesFilter(t: PumpFunTokenCandidate, opts: DiscoverOptions, now: number): boolean {
    if (opts.minMarketCapUsd != null && t.marketCapUsd < opts.minMarketCapUsd) return false;
    if (opts.maxAgeMinutes != null) {
      const ageMin = (now - t.createdAtMs) / 60_000;
      if (ageMin > opts.maxAgeMinutes) return false;
    }
    if (opts.lifecycleAllowlist && opts.lifecycleAllowlist.length > 0) {
      if (!opts.lifecycleAllowlist.includes(t.lifecycle)) return false;
    }
    return true;
  }

  private async fetchCoins(limit: number): Promise<PumpFunRawCoin[]> {
    const url = new URL('/coins', this.baseUrl);
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('sort', 'created_timestamp');
    url.searchParams.set('order', 'DESC');
    url.searchParams.set('includeNsfw', 'false');
    const res = await this.fetchImpl(url, { headers: { accept: 'application/json' } });
    if (!res.ok) {
      throw new Error(`pump.fun ${res.status}`);
    }
    return (await res.json()) as PumpFunRawCoin[];
  }
}
