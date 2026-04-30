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

const PUMP_API_BASE = 'https://frontend-api-v3.pump.fun';

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

  // ── Load open positions ───────────────────────────────────────
  const openPositions: PumpPosition[] = Array.isArray(ctx.payload.positions)
    ? (ctx.payload.positions as PumpPosition[])
    : [];

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
      const exitReason = checkExit(position, currentMarketCapUsd);

      if (!exitReason) {
        remainingPositions.push(position);
        continue;
      }

      // Determine sell quantity.
      let tokenBalance: bigint;
      if (position.tokenBalance && position.tokenBalance > 0) {
        tokenBalance = BigInt(Math.floor(position.tokenBalance));
      } else {
        try {
          tokenBalance = await getSolanaTokenBalance(walletAddress, position.mint, rpcUrl);
        } catch (e) {
          logRaw(`[pumpfun] balance fetch failed for ${position.symbol}: ${(e as Error).message}`, 'pumpfun-trade');
          remainingPositions.push(position);
          continue;
        }
      }

      if (tokenBalance === 0n) {
        // Already sold or never confirmed — remove from list.
        logActivity(`[pumpfun] ${position.symbol} has zero balance — removing position (${exitReason})`, 'pumpfun-trade');
        continue;
      }

      logActivity(`[pumpfun] EXIT ${position.symbol} reason=${exitReason} cap=$${currentMarketCapUsd.toFixed(0)} entry=$${position.entryMarketCapUsd.toFixed(0)}`, 'pumpfun-trade');

      try {
        const result = await executePumpFunTrade(
          {
            publicKey: walletAddress,
            action: 'sell',
            mint: position.mint,
            amountTokens: Number(tokenBalance),
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
          remainingPositions.push(position);
        }
      } catch (e) {
        logRaw(`[pumpfun] sell error ${position.symbol}: ${(e as Error).message}`, 'pumpfun-trade');
        remainingPositions.push(position);
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
      maxAgeMinutes: 5,
      minMarketCapUsd: 3_000,
      maxMarketCapUsd: 25_000,
      lifecycleAllowlist: ['new_launch', 'bonding_curve'],
    });
  } catch (e) {
    logRaw(`[pumpfun] discovery failed: ${(e as Error).message}`, 'pumpfun-trade');
  }

  for (const candidate of candidates) {
    if (!shouldEnter(candidate, remainingPositions)) continue;

    logActivity(`[pumpfun] ENTER ${candidate.symbol} cap=$${candidate.marketCapUsd.toFixed(0)} sol=${tradeSol}`, 'pumpfun-trade');

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
    if (remainingPositions.length >= 3) break;
  }

  // ── Persist state ─────────────────────────────────────────────
  await ctx.savePayload({
    enabled: true,
    positions: remainingPositions,
    activityLog: getActivityLog('pumpfun-trade'),
    rawLog: getRawLog('pumpfun-trade'),
    daemon: {
      lastTickAt: new Date().toISOString(),
      worker: 'pumpfun-trade',
      status: 'running',
    },
  });
}
