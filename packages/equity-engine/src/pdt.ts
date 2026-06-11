/**
 * Pattern Day Trader (PDT) tracking.
 *
 * A "day trade" is opening and closing the same security on the same trading
 * day. FINRA flags an account as a pattern day trader at 4+ day trades in 5
 * rolling business days; accounts under $25k equity are then restricted. b1dz's
 * engine hard-blocks the 4th day trade rather than let the broker reject it.
 *
 * Pure helpers — the daemon records each closing day-trade timestamp and asks
 * these for the rolling count + whether the next one would trip the rule.
 */

/** Count day trades whose timestamp falls within the trailing 5 calendar days.
 *  (5 calendar days is a deliberately conservative proxy for 5 business days —
 *  it never *under*-counts, so it can't let a blocked trade through.) */
export function countRecentDayTrades(dayTradeTimestamps: number[], now = Date.now()): number {
  const windowStart = now - 5 * 24 * 60 * 60 * 1000;
  return dayTradeTimestamps.filter((t) => t >= windowStart && t <= now).length;
}

/** Is the account PDT-restricted? Only margin accounts under $25k equity are. */
export function isPdtRestricted(equityUsd: number | undefined): boolean {
  return equityUsd !== undefined && equityUsd < 25_000;
}

/** Would the next day trade be blocked (i.e. it'd be the 4th in 5 days)? */
export function wouldExceedPdt(recentDayTrades: number, equityUsd: number | undefined): boolean {
  return isPdtRestricted(equityUsd) && recentDayTrades >= 3;
}
