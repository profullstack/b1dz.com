/**
 * Pure helper: decide how to label the top-bar PnL / fees / freshness
 * given the current `tradeState` payload and wallclock. Extracted from
 * crypto-dashboard.tsx so the derivation can be unit-tested without
 * standing up a react-blessed harness.
 *
 * Returns the three parts of the status bar that depend on freshness.
 * Blessed color tags are intentionally included — the tests assert on
 * them as plain substrings so regressions (e.g. accidentally dropping
 * the "loading…" badge) show up as failing string matches.
 */
export const TRADE_STALE_AFTER_MS = 10_000;

export interface StatusFreshnessInput {
  /** True when tradeState or its embedded tradeStatus is missing. */
  dataLoading: boolean;
  /** Epoch ms from `tradeState.daemon.lastTickAt`, or null if absent. */
  lastTickMs: number | null;
  /** Wallclock "now" for age math (passed in for testability). */
  nowMs: number;
  /** Realized PnL today (USD). Ignored when dataLoading. */
  realizedPnl: number;
  /** Realized PnL today as % of starting equity. Ignored when dataLoading. */
  realizedPnlPct: number;
  /** Total fees today (USD). Ignored when dataLoading. */
  totalFees: number;
}

export interface StatusFreshnessOutput {
  pnlStr: string;
  pnlPctStr: string;
  feesStr: string;
  /** Leading double-space is baked in so the caller can concat with "". */
  freshnessStr: string;
  /** Integer seconds since lastTickMs, clamped to 0. 0 when loading/unknown. */
  staleSec: number;
  /** True iff data has loaded and lastTickMs is older than TRADE_STALE_AFTER_MS. */
  isStale: boolean;
}

export function computeStatusFreshness(input: StatusFreshnessInput): StatusFreshnessOutput {
  const { dataLoading, lastTickMs, nowMs, realizedPnl, realizedPnlPct, totalFees } = input;

  const haveTick = lastTickMs != null && Number.isFinite(lastTickMs);
  const staleSec = !dataLoading && haveTick
    ? Math.max(0, Math.floor((nowMs - (lastTickMs as number)) / 1000))
    : 0;
  const isStale = !dataLoading && haveTick && (nowMs - (lastTickMs as number)) > TRADE_STALE_AFTER_MS;

  const pnlStr = dataLoading
    ? '{white-fg}—{/}'
    : realizedPnl >= 0
      ? `{green-fg}+$${realizedPnl.toFixed(2)}{/}`
      : `{red-fg}$${realizedPnl.toFixed(2)}{/}`;

  const pnlPctStr = dataLoading
    ? ''
    : realizedPnlPct >= 0
      ? ` {green-fg}(+${realizedPnlPct.toFixed(2)}%){/}`
      : ` {red-fg}(${realizedPnlPct.toFixed(2)}%){/}`;

  const feesStr = dataLoading ? '—' : `$${totalFees.toFixed(2)}`;

  const freshnessStr = dataLoading
    ? `  {black-fg}{white-bg} loading… {/}`
    : isStale
      ? `  {black-fg}{yellow-bg} stale ${staleSec}s {/}`
      : '';

  return { pnlStr, pnlPctStr, feesStr, freshnessStr, staleSec, isStale };
}
