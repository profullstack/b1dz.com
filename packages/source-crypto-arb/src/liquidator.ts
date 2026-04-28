/**
 * Seed-funding liquidator.
 *
 * Triggered when the auto-seeder wants to seed a pair but stablecoin
 * balance on the target exchange is below SEED_MIN_USD. Finds an
 * UNTRACKED, non-stable base-asset holding on the same exchange and
 * sells a small slice of it for USDC/USDT/USD — just enough to fund
 * the seed plus a small buffer.
 *
 * Hard guarantees (enforced here — see liquidator.test.ts):
 *   1. NEVER sells anything the daemon's trade engine is currently
 *      tracking as an open position. The caller passes in the set of
 *      protected (exchange, baseAsset) keys and we filter on it.
 *   2. NEVER sells the base asset we're about to seed into (we'd just
 *      be selling what we want to buy).
 *   3. NEVER sells stablecoins — those ARE the thing we want.
 *   4. Liquidates at most a small slice (LIQUIDATE_MAX_SLICE_USD) per
 *      event, so if a holding is large we only dip into it.
 *   5. Skips candidates whose USD value is below LIQUIDATE_MIN_ASSET_USD
 *      (fee-noise for dust).
 *   6. Per-exchange cooldown so one weird spread can't trigger a dozen
 *      liquidations in a minute.
 *   7. Honored by the same tradingEnabled kill switch as the seeder.
 *
 * Decision function is pure. Order placement lives in
 * ./liquidator-executor.ts.
 */

export const LIQUIDATE_MAX_SLICE_USD = Number(process.env.ARB_LIQ_MAX_SLICE_USD ?? 30);
export const LIQUIDATE_MIN_ASSET_USD = Number(process.env.ARB_LIQ_MIN_ASSET_USD ?? 15);
export const LIQUIDATE_COOLDOWN_MS = Number(process.env.ARB_LIQ_COOLDOWN_MS ?? 10 * 60_000);
/** Stables we're willing to end up with after the sell — priority order. */
export const LIQUIDATE_STABLE_PRIORITY = ['USDC', 'USDT', 'USD'] as const;

/** Key used to store liquidator state in the crypto-arb payload. */
export const LIQUIDATOR_STATE_PAYLOAD_KEY = 'arbLiqState';

export interface LiquidatorState {
  /** Per-exchange last-liquidated timestamp (ms). */
  lastLiquidatedAtMs: Record<string, number>;
}

export function emptyLiquidatorState(): LiquidatorState {
  return { lastLiquidatedAtMs: {} };
}

export function normalizeLiquidatorState(raw: unknown): LiquidatorState {
  if (!raw || typeof raw !== 'object') return emptyLiquidatorState();
  const obj = raw as Partial<LiquidatorState>;
  const out: Record<string, number> = {};
  if (obj.lastLiquidatedAtMs && typeof obj.lastLiquidatedAtMs === 'object') {
    for (const [k, v] of Object.entries(obj.lastLiquidatedAtMs as Record<string, unknown>)) {
      const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
      if (Number.isFinite(n)) out[k] = n;
    }
  }
  return { lastLiquidatedAtMs: out };
}

export interface Holding {
  /** Base-asset symbol (canonical, e.g. 'ADA', 'DOGE'). For Kraken we
   *  normalize XXDG → DOGE, XXBT → BTC, etc. upstream. */
  asset: string;
  /** Amount of the base asset held on this exchange. */
  amount: number;
  /** Live unit price (USD) for size math. 0 means "unknown, skip". */
  unitPriceUsd: number;
}

export type LiquidateDecisionKind =
  /** Go: sell `sellVolume` of `asset` on `exchange` at `limitPriceUsd`. */
  | { kind: 'liquidate'; exchange: string; asset: string; sellVolume: number; limitPriceUsd: number; expectedUsd: number }
  /** Skipped: trading is off. */
  | { kind: 'disabled' }
  /** Skipped: cooldown on this exchange is still active. */
  | { kind: 'cooldown'; remainingMs: number }
  /** Skipped: we already have enough stables — caller should just seed. */
  | { kind: 'already-funded'; stableBalance: number }
  /** Skipped: no eligible untracked holding to sell. Includes the full list
   *  of holdings we considered and the reason each was rejected so the TUI
   *  and logs can explain the "why". */
  | { kind: 'no-candidate'; reasons: Array<{ asset: string; reason: string }> };

export interface LiquidateDecisionInput {
  /** The exchange we need stables on. */
  exchange: string;
  /** Holdings on that exchange (non-stable only — caller filters stables). */
  holdings: Holding[];
  /** Current stablecoin balance on the exchange (USDC+USDT+USD summed). */
  stableBalance: number;
  /** Base asset of the pair we're about to seed (must not liquidate it!). */
  seedBaseAsset: string;
  /** USD amount we want the liquidation to yield (seed size + buffer). */
  wantUsd: number;
  /** Protected (exchange, asset) keys — daemon-tracked open positions.
   *  `liqKey(exchange, asset)` format. */
  protectedKeys: Set<string>;
  /** Wallclock. */
  nowMs: number;
  /** Trading kill switch. */
  tradingEnabled: boolean;
  /** Current liquidator state (cooldowns). */
  state: LiquidatorState;
}

export function liqKey(exchange: string, asset: string): string {
  return `${exchange}:${asset}`;
}

export function decideLiquidate(input: LiquidateDecisionInput): LiquidateDecisionKind {
  if (!input.tradingEnabled) return { kind: 'disabled' };

  if (input.stableBalance >= input.wantUsd) {
    return { kind: 'already-funded', stableBalance: input.stableBalance };
  }

  const lastLiq = input.state.lastLiquidatedAtMs[input.exchange] ?? 0;
  const cooldownRemaining = (lastLiq + LIQUIDATE_COOLDOWN_MS) - input.nowMs;
  if (cooldownRemaining > 0) {
    return { kind: 'cooldown', remainingMs: cooldownRemaining };
  }

  const reasons: Array<{ asset: string; reason: string }> = [];
  // Rank candidates by USD value descending so we prefer liquidating from
  // larger bags (one small slice is less disruptive than draining a tiny bag).
  const ranked = [...input.holdings].sort((a, b) => (b.amount * b.unitPriceUsd) - (a.amount * a.unitPriceUsd));

  for (const h of ranked) {
    const assetUsd = h.amount * h.unitPriceUsd;
    if (!(h.amount > 0) || !(h.unitPriceUsd > 0) || !Number.isFinite(assetUsd)) {
      reasons.push({ asset: h.asset, reason: 'no price' });
      continue;
    }
    if (h.asset === input.seedBaseAsset) {
      reasons.push({ asset: h.asset, reason: 'same as seed target' });
      continue;
    }
    if (input.protectedKeys.has(liqKey(input.exchange, h.asset))) {
      reasons.push({ asset: h.asset, reason: 'tracked position' });
      continue;
    }
    if (assetUsd < LIQUIDATE_MIN_ASSET_USD) {
      reasons.push({ asset: h.asset, reason: `only $${assetUsd.toFixed(2)} < $${LIQUIDATE_MIN_ASSET_USD}` });
      continue;
    }

    // Size the sell: enough to cover the funding gap, with a small buffer
    // for fees+slippage, but never more than LIQUIDATE_MAX_SLICE_USD and
    // never more than half the asset's USD value (keep something in the bag).
    const funding = Math.max(0, input.wantUsd - input.stableBalance);
    const targetUsd = funding * 1.05; // 5% buffer for fees + slippage
    const cappedUsd = Math.min(targetUsd, LIQUIDATE_MAX_SLICE_USD, assetUsd * 0.5);

    if (cappedUsd < LIQUIDATE_MIN_ASSET_USD) {
      reasons.push({ asset: h.asset, reason: `slice $${cappedUsd.toFixed(2)} < $${LIQUIDATE_MIN_ASSET_USD}` });
      continue;
    }

    // Aggressive (slippage-tolerant) limit so the IOC actually crosses.
    const limitPriceUsd = h.unitPriceUsd * 0.9975;
    const sellVolume = cappedUsd / h.unitPriceUsd;

    return {
      kind: 'liquidate',
      exchange: input.exchange,
      asset: h.asset,
      sellVolume,
      limitPriceUsd,
      expectedUsd: sellVolume * limitPriceUsd,
    };
  }

  return { kind: 'no-candidate', reasons };
}

/** Stamp a liquidation event into state. Pure. */
export function recordLiquidation(state: LiquidatorState, args: {
  exchange: string;
  nowMs: number;
}): LiquidatorState {
  return {
    lastLiquidatedAtMs: { ...state.lastLiquidatedAtMs, [args.exchange]: args.nowMs },
  };
}
