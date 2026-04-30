/**
 * Pump.fun bonding-curve math (PRD §14.4, §17).
 *
 * Pure functions — no side effects, no imports. All arithmetic uses
 * BigInt to avoid floating-point precision loss on lamport-scale values.
 *
 * The bonding curve is a constant-product AMM (k = virtualSolReserves *
 * virtualTokenReserves). Pump.fun charges a 1% fee on every trade;
 * for buys the fee is deducted from the incoming SOL before the AMM
 * formula runs, and for sells the fee is deducted from the outgoing SOL.
 */

/** Pump.fun protocol fee: 100 bps = 1%. */
export const PUMPFUN_FEE_BPS = 100n;

/**
 * Compute tokens received for `solLamports` of SOL.
 *
 * Formula:
 *   netSol = solLamports * (10000 - 100) / 10000   (deduct 1% fee)
 *   tokens = virtualTokenReserves * netSol / (virtualSolReserves + netSol)
 *
 * @param virtualSolReserves   Current virtual SOL reserves (lamports, bigint)
 * @param virtualTokenReserves Current virtual token reserves (raw units, bigint)
 * @param solLamports          SOL amount being spent (lamports, bigint)
 * @returns                    Token units received (raw, bigint)
 */
export function solToTokensOut(
  virtualSolReserves: bigint,
  virtualTokenReserves: bigint,
  solLamports: bigint,
): bigint {
  if (solLamports <= 0n || virtualSolReserves <= 0n || virtualTokenReserves <= 0n) return 0n;
  const netSol = (solLamports * (10_000n - PUMPFUN_FEE_BPS)) / 10_000n;
  if (netSol <= 0n) return 0n;
  return (virtualTokenReserves * netSol) / (virtualSolReserves + netSol);
}

/**
 * Compute SOL received (in lamports) for selling `tokenAmount` tokens.
 *
 * Formula (fee deducted from gross SOL out):
 *   gross = virtualSolReserves * tokenAmount / (virtualTokenReserves + tokenAmount)
 *   net   = gross * (10000 - 100) / 10000
 *
 * @param virtualSolReserves   Current virtual SOL reserves (lamports, bigint)
 * @param virtualTokenReserves Current virtual token reserves (raw units, bigint)
 * @param tokenAmount          Token units being sold (bigint)
 * @returns                    Lamports received after fee (bigint)
 */
export function tokensToSolOut(
  virtualSolReserves: bigint,
  virtualTokenReserves: bigint,
  tokenAmount: bigint,
): bigint {
  if (tokenAmount <= 0n || virtualSolReserves <= 0n || virtualTokenReserves <= 0n) return 0n;
  const gross = (virtualSolReserves * tokenAmount) / (virtualTokenReserves + tokenAmount);
  if (gross <= 0n) return 0n;
  return (gross * (10_000n - PUMPFUN_FEE_BPS)) / 10_000n;
}

/**
 * Instantaneous token price in SOL (float, for display only).
 *
 * Price = virtualSolReserves / virtualTokenReserves
 * (the marginal AMM price before any fees or slippage)
 *
 * @param virtualSolReserves   Virtual SOL reserves (lamports, bigint)
 * @param virtualTokenReserves Virtual token reserves (raw units, bigint)
 * @returns                    Price in SOL per token (float)
 */
export function tokenPriceSol(
  virtualSolReserves: bigint,
  virtualTokenReserves: bigint,
): number {
  if (virtualTokenReserves <= 0n) return 0;
  return Number(virtualSolReserves) / Number(virtualTokenReserves);
}
