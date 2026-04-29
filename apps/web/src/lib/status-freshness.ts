/**
 * Web port of apps/cli/src/tui/statusFreshness.ts.
 *
 * Same semantics, but returns structured values (sign, magnitude, color)
 * instead of blessed color tags so React can style the chunks directly.
 *
 * The CLI helper stays the source of truth for blessed rendering. This
 * duplication is intentional — keeps apps/web from importing apps/cli.
 */

export const TRADE_STALE_AFTER_MS = 10_000;

export type Tone = 'pos' | 'neg' | 'zero' | 'loading';

export interface StatusFreshnessInput {
  dataLoading: boolean;
  lastTickMs: number | null;
  nowMs: number;
  realizedPnl: number;
  realizedPnlPct: number;
  totalFees: number;
  unrealizedPnl?: number;
  unrealizedPnlPct?: number;
  hasOpenPositions?: boolean;
}

export interface StatusFreshnessOutput {
  pnlText: string;
  pnlPctText: string;
  pnlTone: Tone;
  feesText: string;
  unrealizedText: string | null;
  unrealizedPctText: string | null;
  unrealizedTone: Tone;
  staleSec: number;
  isStale: boolean;
  isLoading: boolean;
}

export function computeStatusFreshness(input: StatusFreshnessInput): StatusFreshnessOutput {
  const { dataLoading, lastTickMs, nowMs, realizedPnl, realizedPnlPct, totalFees } = input;

  const haveTick = lastTickMs != null && Number.isFinite(lastTickMs);
  const staleSec = !dataLoading && haveTick
    ? Math.max(0, Math.floor((nowMs - (lastTickMs as number)) / 1000))
    : 0;
  const isStale = !dataLoading && haveTick && (nowMs - (lastTickMs as number)) > TRADE_STALE_AFTER_MS;

  const pnlTone: Tone = dataLoading ? 'loading' : realizedPnl >= 0 ? 'pos' : 'neg';
  const pnlText = dataLoading
    ? '—'
    : realizedPnl >= 0
      ? `+$${realizedPnl.toFixed(2)}`
      : `$${realizedPnl.toFixed(2)}`;
  const pnlPctText = dataLoading
    ? ''
    : realizedPnlPct >= 0
      ? `+${realizedPnlPct.toFixed(2)}%`
      : `${realizedPnlPct.toFixed(2)}%`;

  const feesText = dataLoading ? '—' : `$${totalFees.toFixed(2)}`;

  const unrealizedPnl = typeof input.unrealizedPnl === 'number' && Number.isFinite(input.unrealizedPnl) ? input.unrealizedPnl : 0;
  const unrealizedPnlPct = typeof input.unrealizedPnlPct === 'number' && Number.isFinite(input.unrealizedPnlPct) ? input.unrealizedPnlPct : 0;
  const showUnrealized = !dataLoading && (input.hasOpenPositions === true);
  const unrealizedTone: Tone = !showUnrealized ? 'zero' : unrealizedPnl >= 0 ? 'pos' : 'neg';
  const unrealizedText = showUnrealized
    ? `${unrealizedPnl >= 0 ? '+' : ''}$${unrealizedPnl.toFixed(2)}`
    : null;
  const unrealizedPctText = showUnrealized && Math.abs(unrealizedPnlPct) > 0.005
    ? `${unrealizedPnlPct >= 0 ? '+' : ''}${unrealizedPnlPct.toFixed(2)}%`
    : null;

  return {
    pnlText,
    pnlPctText,
    pnlTone,
    feesText,
    unrealizedText,
    unrealizedPctText,
    unrealizedTone,
    staleSec,
    isStale,
    isLoading: dataLoading,
  };
}

export function toneColor(tone: Tone): string {
  switch (tone) {
    case 'pos': return 'text-emerald-400';
    case 'neg': return 'text-red-400';
    case 'loading': return 'text-zinc-500';
    default: return 'text-zinc-300';
  }
}
