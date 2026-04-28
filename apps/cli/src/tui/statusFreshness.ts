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
  /** Sum of live PnL across all open positions (USD). Optional — when
   *  absent or exactly 0 (no open positions), the "open:" badge is omitted
   *  so the top bar stays clean. */
  unrealizedPnl?: number;
  /** Unrealized PnL as % of the open-position notional. Optional. */
  unrealizedPnlPct?: number;
  /** Whether at least one position is currently open. If false, the
   *  "open:" chunk is suppressed regardless of unrealizedPnl value. */
  hasOpenPositions?: boolean;
}

export interface StatusFreshnessOutput {
  pnlStr: string;
  pnlPctStr: string;
  feesStr: string;
  /** Unrealized PnL chunk ("  open:+$4.20 (+0.8%)") or '' when no
   *  positions / no data. Pre-formatted with its own leading spaces so the
   *  caller can concat directly. */
  unrealizedStr: string;
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

  // Unrealized PnL chunk: only rendered when the daemon reports at least one
  // open position. Marks-to-market every tick so losing positions tick red
  // and winning positions tick green in realtime without waiting for a close.
  const unrealizedPnl = typeof input.unrealizedPnl === 'number' && Number.isFinite(input.unrealizedPnl) ? input.unrealizedPnl : 0;
  const unrealizedPnlPct = typeof input.unrealizedPnlPct === 'number' && Number.isFinite(input.unrealizedPnlPct) ? input.unrealizedPnlPct : 0;
  const showUnrealized = !dataLoading && (input.hasOpenPositions === true);
  const unrealizedStr = showUnrealized
    ? (() => {
        const color = unrealizedPnl >= 0 ? '{green-fg}' : '{red-fg}';
        const sign = unrealizedPnl >= 0 ? '+' : '';
        const pctSign = unrealizedPnlPct >= 0 ? '+' : '';
        const pctPart = Number.isFinite(unrealizedPnlPct) && Math.abs(unrealizedPnlPct) > 0.005
          ? ` ${color}(${pctSign}${unrealizedPnlPct.toFixed(2)}%){/}`
          : '';
        return `  open:${color}${sign}$${unrealizedPnl.toFixed(2)}{/}${pctPart}`;
      })()
    : '';

  const freshnessStr = dataLoading
    ? `  {black-fg}{white-bg} loading… {/}`
    : isStale
      ? `  {black-fg}{yellow-bg} stale ${staleSec}s {/}`
      : '';

  return { pnlStr, pnlPctStr, feesStr, unrealizedStr, freshnessStr, staleSec, isStale };
}
