/**
 * Dollar-Cost Averaging (DCA) configuration helpers.
 *
 * All defaults come from env vars so operators can tune without a code
 * change. Every helper is evaluated at call time (not module load) so
 * Railway env flips are picked up on the next daemon tick.
 */

export const DCA_DEFAULTS = {
  enabled: true,
  totalAllocationPct: 10,
  maxCoins: 3,
  coins: ['BTC', 'ETH', 'SOL'],
  exchanges: ['kraken', 'coinbase', 'binance-us', 'gemini'],
  intervalMs: 24 * 60 * 60 * 1000,
} as const;

function readBoolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === '') return fallback;
  if (raw === 'true' || raw === '1' || raw === 'yes') return true;
  if (raw === 'false' || raw === '0' || raw === 'no') return false;
  return fallback;
}

function readNumberEnv(name: string, fallback: number, min = 0): number {
  const v = Number.parseFloat(process.env[name] ?? '');
  if (!Number.isFinite(v)) return fallback;
  return v >= min ? v : fallback;
}

function readListEnv(name: string, fallback: readonly string[]): string[] {
  const raw = process.env[name]?.trim();
  if (!raw) return [...fallback];
  const parts = raw.split(',').map((s) => s.trim()).filter(Boolean);
  return parts.length > 0 ? parts : [...fallback];
}

export interface DcaConfig {
  enabled: boolean;
  totalAllocationPct: number;
  maxCoins: number;
  coins: string[];
  exchanges: string[];
  intervalMs: number;
}

export function dcaConfigFromEnv(): DcaConfig {
  return {
    enabled: readBoolEnv('DCA_ENABLED', DCA_DEFAULTS.enabled),
    totalAllocationPct: readNumberEnv('DCA_TOTAL_ALLOCATION_PCT', DCA_DEFAULTS.totalAllocationPct, 0),
    maxCoins: Math.max(1, Math.floor(readNumberEnv('DCA_MAX_COINS', DCA_DEFAULTS.maxCoins, 1))),
    coins: readListEnv('DCA_COINS', DCA_DEFAULTS.coins).map((c) => c.toUpperCase()),
    exchanges: readListEnv('DCA_EXCHANGES', DCA_DEFAULTS.exchanges).map((e) => e.toLowerCase()),
    intervalMs: readNumberEnv('DCA_INTERVAL_MS', DCA_DEFAULTS.intervalMs, 1000),
  };
}

/** Per-exchange fraction of equity dedicated to DCA.
 *  Splits the total evenly across exchanges. Returns 0 if disabled or
 *  no exchanges configured. */
export function perExchangeAllocationPct(config: DcaConfig): number {
  if (!config.enabled || config.exchanges.length === 0) return 0;
  return config.totalAllocationPct / config.exchanges.length;
}
