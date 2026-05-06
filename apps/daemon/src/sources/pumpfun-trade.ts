/**
 * Pump.fun live trading worker (PRD §14.4, §17, §29 Phase 4).
 *
 * Polls every 10 seconds. Each tick:
 *   1. Checks PUMPFUN_TRADE_EXECUTION env flag — hard gate, no trades
 *      without it.
 *   2. Creates a DirectSolanaWalletProvider from SOLANA_PRIVATE_KEY.
 *   3. Runs the exit pass: checks each open position against the
 *      pump.fun coin API and exits if any trigger fires.
 *   4. Runs the entry pass: discovers recent bonding-curve tokens and
 *      opens new positions if shouldEnter() approves.
 *   5. Persists the updated position list and activity log.
 *
 * Capital safety: PUMPFUN_TRADE_EXECUTION must be 'true' and
 * SOLANA_PRIVATE_KEY + SOLANA_RPC_URL must be set. Any single-trade
 * error is caught and logged without crashing the tick.
 */

import type { SourceWorker, UserContext } from '../types.js';
import { DirectSolanaWalletProvider } from '@b1dz/wallet-direct';
import {
  PumpFunDiscoveryAdapter,
  executePumpFunTrade,
  getSolanaTokenBalance,
  shouldEnter,
  checkExit,
  type PumpPosition,
} from '@b1dz/adapters-pumpfun';
import { logActivity, logRaw, getActivityLog, getRawLog } from './activity-log.js';

/** Per-candidate mcap history for momentum gating. Keyed by mint, stores
 *  (timestamp, usd_market_cap) pairs across recent ticks. Used to compute
 *  a 5-minute mcap change so we can skip candidates that are already
 *  dumping. Module-scope so it survives between ticks; pruned aggressively
 *  by mint last-seen so unbounded growth isn't possible.
 *
 *  CANDIDATE_HISTORY_TTL_MS controls how long we keep mints we haven't
 *  seen recently — once a candidate falls outside the discovery filter
 *  it ages out. */
const candidateMcapHistory = new Map<string, { at: number; mcap: number }[]>();
const CANDIDATE_HISTORY_TTL_MS = 30 * 60_000; // 30 min
const CANDIDATE_HISTORY_MAX_SAMPLES = 60;     // ~10 min at 10s ticks

function recordCandidateMcap(mint: string, mcap: number, nowMs: number): void {
  if (!Number.isFinite(mcap) || mcap <= 0) return;
  const samples = candidateMcapHistory.get(mint) ?? [];
  samples.push({ at: nowMs, mcap });
  while (samples.length > CANDIDATE_HISTORY_MAX_SAMPLES) samples.shift();
  candidateMcapHistory.set(mint, samples);
}

function pruneCandidateHistory(nowMs: number): void {
  for (const [mint, samples] of candidateMcapHistory) {
    const newest = samples[samples.length - 1]?.at ?? 0;
    if (nowMs - newest > CANDIDATE_HISTORY_TTL_MS) candidateMcapHistory.delete(mint);
  }
}

/** Returns the percentage change in mcap over the trailing `windowMs`,
 *  or null when we don't have at least one sample older than the window
 *  (i.e. we can't yet compute the change reliably). */
function mcapPctChange(mint: string, windowMs: number, nowMs: number): number | null {
  const samples = candidateMcapHistory.get(mint);
  if (!samples || samples.length < 2) return null;
  const cutoff = nowMs - windowMs;
  // Find the oldest sample inside the window. If even our oldest sample
  // is younger than the window, we don't have enough history yet.
  const oldest = samples.find((s) => s.at >= cutoff) ?? samples[0];
  if (!oldest || nowMs - oldest.at < windowMs * 0.5) return null;
  const newest = samples[samples.length - 1];
  if (!oldest.mcap || !newest.mcap) return null;
  return ((newest.mcap - oldest.mcap) / oldest.mcap) * 100;
}

/** Pull a recent SOL/USD price from the crypto-arb worker's persisted prices
 *  array so the panel can show USD P&L on pump.fun positions. The arb worker
 *  refreshes prices every couple seconds, so this is at most a few seconds
 *  stale — accurate enough for an approximate P&L display. Returns 0 when no
 *  cached price is available (UI falls back to %-only). */
async function readSolUsdRef(ctx: UserContext): Promise<number> {
  try {
    const { data } = await ctx.supabase
      .from('source_state')
      .select('payload')
      .eq('user_id', ctx.userId)
      .eq('source_id', 'crypto-arb')
      .maybeSingle();
    const prices = (data?.payload as { prices?: { pair: string; bid: number }[] } | null)?.prices ?? [];
    let best = 0;
    for (const p of prices) {
      if (p.pair === 'SOL-USD' && Number.isFinite(p.bid) && p.bid > best) best = p.bid;
    }
    return best;
  } catch {
    return 0;
  }
}

const PUMP_API_BASE = 'https://frontend-api-v3.pump.fun';

/** Cap on mcapSamples per position so payloads don't grow unbounded. */
const MCAP_SAMPLE_LIMIT = 30;

// ─── Coin status shape (partial) ─────────────────────────────────

interface PumpCoinStatus {
  usd_market_cap: number;
  virtual_sol_reserves: number;
  virtual_token_reserves: number;
  complete: boolean;
  raydium_pool: string | null;
  pumpswap_pool: string | null;
}

async function fetchCoinStatus(mint: string): Promise<PumpCoinStatus | null> {
  try {
    const res = await fetch(`${PUMP_API_BASE}/coins/${mint}`, {
      headers: { accept: 'application/json' },
    });
    if (!res.ok) return null;
    return (await res.json()) as PumpCoinStatus;
  } catch {
    return null;
  }
}

/** Holder distribution snapshot. Pump.fun's /coins/holders/{mint}
 *  endpoint returns the top-N holders sorted by token amount. We use
 *  it to gate entries on "real distribution exists." Tokens with
 *  totalHolders < ~10 are typically dead-on-arrival. */
interface PumpHolderSnapshot {
  /** Total number of unique holders (the trustworthy signal — many tokens
   *  return an empty `holders` array even when totalHolders > 0 because
   *  pump.fun aggregates in batches). */
  totalHolders: number;
  /** Top holder's token amount, used for concentration ratio. May be
   *  the bonding-curve PDA itself in early-stage tokens. */
  topAmount: number;
  /** Second holder's token amount, useful for "top is bonding curve, what
   *  about real human holders" comparisons. */
  secondAmount: number;
}

async function fetchHolderSnapshot(mint: string): Promise<PumpHolderSnapshot | null> {
  try {
    const res = await fetch(`${PUMP_API_BASE}/coins/holders/${mint}?limit=5`, {
      headers: { accept: 'application/json' },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      holders?: { address: string; amount: number }[];
      totalHolders?: number;
    };
    const holders = Array.isArray(body.holders) ? body.holders : [];
    return {
      totalHolders: Number(body.totalHolders ?? holders.length),
      topAmount: holders[0]?.amount ?? 0,
      secondAmount: holders[1]?.amount ?? 0,
    };
  } catch {
    return null;
  }
}

// ─── Worker ───────────────────────────────────────────────────────

export const pumpfunTradeWorker: SourceWorker = {
  id: 'pumpfun-trade',
  pollIntervalMs: 10_000,

  hasCredentials(payload: Record<string, unknown>): boolean {
    return !!(payload?.enabled);
  },

  async tick(ctx: UserContext): Promise<void> {
    // runtime.ts already applies the per-user env overlay before calling tick().
    // Redirect console output into the activity log for this worker.
    const origLog = console.log;
    const origErr = console.error;
    console.log = (...args: unknown[]) => logRaw(args.map(String).join(' '), 'pumpfun-trade');
    console.error = (...args: unknown[]) => logRaw(args.map(String).join(' '), 'pumpfun-trade');

    try {
      await runTick(ctx);
    } finally {
      console.log = origLog;
      console.error = origErr;
    }
  },
};

async function runTick(ctx: UserContext): Promise<void> {
  // ── Gate: execution flag ──────────────────────────────────────
  const executionEnabled = process.env.PUMPFUN_TRADE_EXECUTION === 'true';
  if (!executionEnabled) {
    logRaw('[pumpfun] PUMPFUN_TRADE_EXECUTION is not true — observation mode only', 'pumpfun-trade');
    await ctx.savePayload({
      enabled: true,
      positions: (ctx.payload.positions as PumpPosition[] | undefined) ?? [],
      daemon: { lastTickAt: new Date().toISOString(), worker: 'pumpfun-trade', status: 'disabled' },
    });
    return;
  }

  // ── Gate: required env vars ───────────────────────────────────
  const solanaKey = process.env.SOLANA_PRIVATE_KEY;
  const rpcUrl = process.env.SOLANA_RPC_URL;
  if (!solanaKey || !rpcUrl) {
    logRaw('[pumpfun] SOLANA_PRIVATE_KEY or SOLANA_RPC_URL missing — skipping tick', 'pumpfun-trade');
    return;
  }

  // ── Wallet ────────────────────────────────────────────────────
  let walletProvider: DirectSolanaWalletProvider;
  let walletAddress: string;
  try {
    walletProvider = new DirectSolanaWalletProvider({ secretKey: solanaKey });
    walletAddress = await walletProvider.getAddress('solana');
  } catch (e) {
    logRaw(`[pumpfun] wallet init failed: ${(e as Error).message}`, 'pumpfun-trade');
    return;
  }

  // Trade size from env (SOL), default 0.01.
  const tradeSol = parseFloat(process.env.PUMPFUN_TRADE_SOL ?? '0.01') || 0.01;

  // Strategy overrides — empty/non-numeric env values fall back to the
  // strategy module's DEFAULT_ENTRY / DEFAULT_EXIT, which already encode
  // sensible values (5k–25k mcap, 10min hold, 30% stop, 50% TP).
  const num = (key: string): number | undefined => {
    const v = process.env[key];
    if (v == null || v === '') return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  const entryConfig = {
    minMarketCapUsd: num('PUMPFUN_ENTRY_MIN_MCAP'),
    maxMarketCapUsd: num('PUMPFUN_ENTRY_MAX_MCAP'),
    maxAgeMinutes: num('PUMPFUN_ENTRY_MAX_AGE_MIN'),
    minAgeMinutes: num('PUMPFUN_ENTRY_MIN_AGE_MIN'),
    maxPositions: num('PUMPFUN_MAX_POSITIONS'),
    minReplyCount: num('PUMPFUN_ENTRY_MIN_REPLIES'),
    minVirtualSolReserves: num('PUMPFUN_ENTRY_MIN_SOL_RESERVES'),
    minCurveProgressPct: num('PUMPFUN_ENTRY_MIN_CURVE_PCT'),
    maxCurveProgressPct: num('PUMPFUN_ENTRY_MAX_CURVE_PCT'),
  };
  const exitConfig = {
    takeProfitPct: num('PUMPFUN_TAKE_PROFIT_PCT'),
    stopLossPct: num('PUMPFUN_STOP_LOSS_PCT'),
    maxHoldMinutes: num('PUMPFUN_MAX_HOLD_MIN'),
    graduationCapUsd: num('PUMPFUN_GRADUATION_CAP_USD'),
  };
  const volumeCollapsePct = num('PUMPFUN_VOLUME_COLLAPSE_PCT') ?? 20;
  const partialExitPct = num('PUMPFUN_PARTIAL_EXIT_PCT') ?? 0.5;
  const partialExitTriggerPct = num('PUMPFUN_PARTIAL_EXIT_TRIGGER_PCT') ?? 0.5;
  // Sell slippage tolerance (percent). Higher than buy slippage because
  // priority on exit is to actually get out — for low-liquidity bag-hold
  // tokens, the bonding curve's price impact when selling the entire
  // bag dwarfs normal slippage. Default 50% accepts effectively any
  // fill; pump.fun 6022 = TooLittleSolReceived (slippage exceeded).
  const sellSlippagePct = num('PUMPFUN_SELL_SLIPPAGE_PCT') ?? 50;
  // Distribution gate: minimum unique holders required to enter. Cheap
  // filter that rejects tokens nobody has actually bought (genesis-only
  // bags, single-buyer rugs). Default 10.
  const minHolders = num('PUMPFUN_ENTRY_MIN_HOLDERS') ?? 10;
  // Concentration gate: ratio of top-1 to top-2 holder. When the top
  // wallet (not necessarily the bonding curve) owns dramatically more
  // than the next, that's a creator/whale concentration risk. Default
  // 50 means top-1 may not exceed 50× the second holder. Set very
  // high to disable.
  const maxTopHolderRatio = num('PUMPFUN_MAX_TOP_HOLDER_RATIO') ?? 50;

  // ── Load open positions ───────────────────────────────────────
  const openPositions: PumpPosition[] = Array.isArray(ctx.payload.positions)
    ? (ctx.payload.positions as PumpPosition[])
    : [];

  // Manual-sell mints — populated by the web "Sell now" button. Each
  // request lasts one tick: we attempt the sell, then drop the entry
  // from the queue regardless of outcome so a stuck mint doesn't loop.
  const manualSellMints = new Set<string>(
    Array.isArray(ctx.payload.manualSellRequests)
      ? (ctx.payload.manualSellRequests as string[])
      : [],
  );

  // ── Exit pass ─────────────────────────────────────────────────
  const remainingPositions: PumpPosition[] = [];
  for (const position of openPositions) {
    try {
      const coin = await fetchCoinStatus(position.mint);
      if (!coin) {
        // Can't fetch status — keep the position, log.
        logRaw(`[pumpfun] could not fetch status for ${position.symbol} (${position.mint.slice(0, 8)}…) — holding`, 'pumpfun-trade');
        remainingPositions.push(position);
        continue;
      }

      const currentMarketCapUsd = coin.usd_market_cap ?? 0;
      const manualSellRequested = manualSellMints.has(position.mint);

      // Volume-collapse / drawdown-from-peak: trailing-stop-style exit
      // that catches dumps which never reach the entry-loss threshold.
      // Compares current mcap against the peak of all recorded samples
      // (since position open). Activates after we have at least 3
      // samples so a single bad fetch can't trip it.
      const samplesSoFar = position.mcapSamples ?? [];
      const peakMcap = samplesSoFar.length >= 3 ? Math.max(...samplesSoFar, currentMarketCapUsd) : 0;
      const drawdownPct = peakMcap > 0 && currentMarketCapUsd > 0
        ? ((peakMcap - currentMarketCapUsd) / peakMcap) * 100
        : 0;
      const volumeCollapse = peakMcap > 0 && drawdownPct >= volumeCollapsePct;

      const exitReason = manualSellRequested
        ? 'manual_sell' as const
        : volumeCollapse
          ? 'volume_collapse' as const
          : checkExit(position, currentMarketCapUsd, exitConfig);

      // Stamp the latest mcap onto the position + append a sparkline
      // sample so the UI panels can compute P&L and draw a chart. Done
      // BEFORE the exit branch so even positions about to exit get one
      // last update visible to the operator.
      const mcapSamples = [...(position.mcapSamples ?? []), currentMarketCapUsd]
        .slice(-MCAP_SAMPLE_LIMIT);
      const updatedPosition: PumpPosition = {
        ...position,
        currentMarketCapUsd,
        mcapSamples,
      };

      // Per-position visibility into why we're holding vs exiting. The
      // previous worker was silent on hold decisions so operators
      // couldn't tell whether the exit pass was even running.
      const heldMin = ((Date.now() - position.entryAt) / 60_000).toFixed(1);
      const lossPct = position.entryMarketCapUsd > 0
        ? ((position.entryMarketCapUsd - currentMarketCapUsd) / position.entryMarketCapUsd * 100).toFixed(1)
        : '?';
      logRaw(`[pumpfun] check ${position.symbol} mcap=$${currentMarketCapUsd.toFixed(0)} loss=${lossPct}% held=${heldMin}m → ${exitReason ?? 'hold'}`, 'pumpfun-trade');

      if (!exitReason) {
        // Tiered partial exit: when a position has a meaningful gain
        // (default +50%), sell `partialExitPct` (default 0.5) of the
        // tokens so principal is largely de-risked, and let the rest
        // ride toward the full take-profit threshold.
        const gainFraction = position.entryMarketCapUsd > 0
          ? (currentMarketCapUsd - position.entryMarketCapUsd) / position.entryMarketCapUsd
          : 0;
        if (
          !position.partialExitDone
          && gainFraction >= partialExitTriggerPct
          && partialExitPct > 0
          && partialExitPct < 1
        ) {
          let tokenBalance: bigint;
          try {
            tokenBalance = position.tokenBalance && position.tokenBalance > 0
              ? BigInt(Math.floor(position.tokenBalance))
              : await getSolanaTokenBalance(walletAddress, position.mint, rpcUrl);
          } catch (e) {
            logRaw(`[pumpfun] partial: balance fetch failed ${position.symbol}: ${(e as Error).message}`, 'pumpfun-trade');
            remainingPositions.push(updatedPosition);
            continue;
          }
          if (tokenBalance > 0n) {
            const partialPctStr = `${Math.max(1, Math.min(99, Math.round(partialExitPct * 100)))}%`;
            logActivity(`[pumpfun] PARTIAL ${position.symbol} +${(gainFraction * 100).toFixed(1)}% — selling ${partialPctStr} of bag`, 'pumpfun-trade');
            try {
              const result = await executePumpFunTrade(
                {
                  publicKey: walletAddress,
                  action: 'sell',
                  mint: position.mint,
                  amountTokens: partialPctStr,
                  slippagePct: sellSlippagePct,
                },
                walletProvider,
                rpcUrl,
              );
              if (result.status === 'confirmed') {
                logActivity(`[pumpfun] partial ✓ ${position.symbol} sig=${result.signature.slice(0, 16)}…`, 'pumpfun-trade');
                remainingPositions.push({
                  ...updatedPosition,
                  tokenBalance: Math.floor(Number(tokenBalance) * (1 - partialExitPct)),
                  partialExitDone: true,
                });
                continue;
              } else {
                logActivity(`[pumpfun] partial ✗ ${position.symbol} ${result.status}: ${result.error ?? ''}`, 'pumpfun-trade');
              }
            } catch (e) {
              logRaw(`[pumpfun] partial error ${position.symbol}: ${(e as Error).message}`, 'pumpfun-trade');
            }
          }
        }
        remainingPositions.push(updatedPosition);
        continue;
      }

      // Full-exit sell: use pumpportal's "100%" syntax. This avoids the
      // raw-vs-human-readable token amount footgun (we don't track decimals)
      // and dodges the SPL-token RPC rate limit that was blocking exits
      // from CLEMENTINE et al. on previous ticks.
      logActivity(`[pumpfun] EXIT ${position.symbol} reason=${exitReason} cap=$${currentMarketCapUsd.toFixed(0)} entry=$${position.entryMarketCapUsd.toFixed(0)}`, 'pumpfun-trade');

      try {
        const result = await executePumpFunTrade(
          {
            publicKey: walletAddress,
            action: 'sell',
            mint: position.mint,
            amountTokens: '100%',
            slippagePct: sellSlippagePct,
          },
          walletProvider,
          rpcUrl,
        );
        if (result.status === 'confirmed') {
          logActivity(`[pumpfun] SOLD ${position.symbol} sig=${result.signature.slice(0, 16)}…`, 'pumpfun-trade');
          // Position removed by not adding to remainingPositions.
        } else {
          logActivity(`[pumpfun] sell ${position.symbol} ${result.status}: ${result.error ?? ''}`, 'pumpfun-trade');
          // Keep the position — will retry next tick.
          remainingPositions.push(updatedPosition);
        }
      } catch (e) {
        logRaw(`[pumpfun] sell error ${position.symbol}: ${(e as Error).message}`, 'pumpfun-trade');
        remainingPositions.push(updatedPosition);
      }
    } catch (e) {
      logRaw(`[pumpfun] exit-pass error ${position.symbol}: ${(e as Error).message}`, 'pumpfun-trade');
      remainingPositions.push(position);
    }
  }

  // ── Entry pass ────────────────────────────────────────────────
  const discovery = new PumpFunDiscoveryAdapter({ enableScrape: true });
  let candidates: Awaited<ReturnType<typeof discovery.discover>> = [];
  try {
    candidates = await discovery.discover({
      maxAgeMinutes: entryConfig.maxAgeMinutes ?? 5,
      minMarketCapUsd: entryConfig.minMarketCapUsd ?? 5_000,
      maxMarketCapUsd: entryConfig.maxMarketCapUsd ?? 25_000,
      lifecycleAllowlist: ['new_launch', 'bonding_curve'],
    });
  } catch (e) {
    logRaw(`[pumpfun] discovery failed: ${(e as Error).message}`, 'pumpfun-trade');
  }

  // Record current mcap for every candidate so we have a rolling window
  // for momentum gating, then prune stale mints.
  const nowMs = Date.now();
  for (const c of candidates) recordCandidateMcap(c.mint, c.marketCapUsd, nowMs);
  pruneCandidateHistory(nowMs);

  // Momentum threshold — minimum 5-minute mcap change required to enter.
  // Default 0% (must be flat or pumping); set negative to permit dips.
  const minPct5m = num('PUMPFUN_ENTRY_MIN_5M_PCT') ?? 0;

  for (const candidate of candidates) {
    if (!shouldEnter(candidate, remainingPositions, entryConfig)) continue;

    // Momentum gate: skip candidates whose 5-min mcap change is below
    // threshold (i.e. already dumping). When we don't have enough
    // history yet (first time seeing this mint), defer entry — better
    // to miss one tick than buy a dump. The catch-22 of "we never
    // build history without entering" doesn't apply because every
    // discovery tick records a sample; on the next tick we'll have
    // enough.
    const pct5m = mcapPctChange(candidate.mint, 5 * 60_000, nowMs);
    if (pct5m == null) {
      logRaw(`[pumpfun] skip ${candidate.symbol}: no 5m history yet`, 'pumpfun-trade');
      continue;
    }
    if (pct5m < minPct5m) {
      logRaw(`[pumpfun] skip ${candidate.symbol}: 5m=${pct5m.toFixed(1)}% < ${minPct5m}% (dumping)`, 'pumpfun-trade');
      continue;
    }

    // Holder-distribution gate: require real holders + reject extreme
    // concentration. Empty holder data means the API didn't index this
    // token yet — we treat that as "no proof of distribution" and
    // defer (better safe than entering a bag).
    const holders = await fetchHolderSnapshot(candidate.mint);
    if (holders == null) {
      logRaw(`[pumpfun] skip ${candidate.symbol}: holders fetch failed`, 'pumpfun-trade');
      continue;
    }
    if (holders.totalHolders < minHolders) {
      logRaw(`[pumpfun] skip ${candidate.symbol}: holders=${holders.totalHolders} < ${minHolders}`, 'pumpfun-trade');
      continue;
    }
    if (holders.secondAmount > 0 && holders.topAmount > 0) {
      const ratio = holders.topAmount / holders.secondAmount;
      if (ratio > maxTopHolderRatio) {
        logRaw(`[pumpfun] skip ${candidate.symbol}: top/2nd ratio ${ratio.toFixed(0)} > ${maxTopHolderRatio} (concentration)`, 'pumpfun-trade');
        continue;
      }
    }

    logActivity(`[pumpfun] ENTER ${candidate.symbol} cap=$${candidate.marketCapUsd.toFixed(0)} 5m=${pct5m >= 0 ? '+' : ''}${pct5m.toFixed(1)}% holders=${holders.totalHolders} creator=${candidate.creator?.slice(0, 8) ?? '?'} sol=${tradeSol}`, 'pumpfun-trade');

    try {
      const result = await executePumpFunTrade(
        {
          publicKey: walletAddress,
          action: 'buy',
          mint: candidate.mint,
          amountSol: tradeSol,
        },
        walletProvider,
        rpcUrl,
      );

      if (result.status === 'confirmed') {
        // Fetch the token balance we received.
        let tokenBalance = 0n;
        try {
          tokenBalance = await getSolanaTokenBalance(walletAddress, candidate.mint, rpcUrl);
        } catch (e) {
          logRaw(`[pumpfun] post-buy balance fetch failed ${candidate.symbol}: ${(e as Error).message}`, 'pumpfun-trade');
        }

        const position: PumpPosition = {
          mint: candidate.mint,
          name: candidate.name,
          symbol: candidate.symbol,
          entryMarketCapUsd: candidate.marketCapUsd,
          entryAt: Date.now(),
          solSpent: tradeSol,
          tokenBalance: Number(tokenBalance),
        };
        remainingPositions.push(position);
        logActivity(`[pumpfun] BOUGHT ${candidate.symbol} sig=${result.signature.slice(0, 16)}… tokens=${tokenBalance}`, 'pumpfun-trade');
      } else {
        logActivity(`[pumpfun] buy ${candidate.symbol} ${result.status}: ${result.error ?? ''}`, 'pumpfun-trade');
      }
    } catch (e) {
      logRaw(`[pumpfun] buy error ${candidate.symbol}: ${(e as Error).message}`, 'pumpfun-trade');
    }

    // Re-check position count after each buy attempt to avoid overfilling.
    if (remainingPositions.length >= (entryConfig.maxPositions ?? 3)) break;
  }

  // ── SOL/USD reference price for the panel's USD P&L column ─────
  const solUsdRef = await readSolUsdRef(ctx);

  // ── Persist state ─────────────────────────────────────────────
  // Drain the manual-sell queue regardless of whether each sell
  // succeeded — see comment at queue load. The worker either took the
  // shot or the position couldn't be sold; either way the request was
  // honored once and shouldn't replay.
  await ctx.savePayload({
    enabled: true,
    positions: remainingPositions,
    solUsdRef,
    manualSellRequests: [],
    activityLog: getActivityLog('pumpfun-trade'),
    rawLog: getRawLog('pumpfun-trade'),
    daemon: {
      lastTickAt: new Date().toISOString(),
      worker: 'pumpfun-trade',
      status: 'running',
    },
  });
}
