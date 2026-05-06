/**
 * Shape of the source-state payloads pulled from /api/storage/source-state/:key.
 * Matches the daemon-emitted shapes consumed by apps/cli's TUI.
 */

export interface ArbState {
  prices?: { exchange: string; pair: string; bid: number; ask: number }[];
  spreads?: {
    pair: string;
    spread: number;
    buyExchange: string;
    sellExchange: string;
    profitable: boolean;
    seedLabel?: string;
    seedStatus?: { kind: string; [k: string]: unknown } | null;
    liqLabel?: string;
    liqStatus?: { kind: string; [k: string]: unknown } | null;
  }[];
  krakenBalance?: Record<string, string>;
  binanceBalance?: Record<string, string>;
  coinbaseBalance?: Record<string, string>;
  geminiBalance?: Record<string, string>;
  exchangeErrors?: Record<string, string | null>;
  binanceDetailedBalance?: { asset: string; free: string; locked: string }[];
  binanceOpenOrders?: {
    symbol: string;
    orderId: number;
    side: string;
    type: string;
    price: string;
    origQty: string;
    executedQty: string;
    status: string;
  }[];
  recentTrades?: { pair: string; type: string; price: string; vol: string; cost: string; fee: string; time: number }[];
  openOrders?: {
    id: string;
    descr: { type: string; pair: string; price: string; order: string };
    vol: string;
    vol_exec: string;
    status: string;
  }[];
  rawLog?: { at: string; text: string }[];
  activityLog?: { at: string; text: string }[];
  daemon?: { lastTickAt: string; worker: string; status: string; version?: string };
}

export interface TradeStatusData {
  positions?: {
    exchange: string;
    pair: string;
    entryPrice: number;
    currentPrice: number;
    volume: number;
    pnlPct: number;
    pnlUsd: number;
    stopPrice: number;
    elapsed: string;
    priceSamples?: number[];
    /** True when this position was synthesized from wallet balance
     *  during cold-start hydration rather than opened by a real buy
     *  signal. The entry gate ignores these for the "one position per
     *  exchange" rule so leftover wallet inventory doesn't lock the
     *  venue out of fresh entries. */
    restoredFromHydration?: boolean;
  }[];
  position?: {
    pair: string;
    entryPrice: number;
    currentPrice: number;
    volume: number;
    pnlPct: number;
    pnlUsd: number;
    stopPrice: number;
    elapsed: string;
    priceSamples?: number[];
  } | null;
  dailyPnl?: number;
  dailyPnlPct?: number;
  dailyFees?: number;
  cumulativePnl?: number;
  cumulativeFees?: number;
  dailyLossLimitHit?: boolean;
  dailyLossLimitPct?: number;
  cooldowns?: { pair: string; remainingSec: number }[];
  eligiblePairs?: number;
  observedPairs?: number;
  pairsScanned?: number;
  ticksPerPair?: Record<string, number>;
  exchangeStates?: { exchange: string; readyPairs: number; warmingPairs: number; openPositions: number; blockedReason: string | null }[];
  lastSignal?: string | null;
  dexExecutionEnabled?: boolean;
  dexExecutorArmed?: boolean;
  /** Wallet USDC balance per DEX venue (uniswap-v3, jupiter), in USD.
   *  Surfaced so the Holdings panel can render DEX rows alongside the
   *  CEX exchanges — previously DEX wallets were invisible and the
   *  only way to know if execution could fire was to grep the
   *  activity log for `[trade] DEX-BUY SKIPPED`. */
  dexBalances?: { venue: string; usdc: number }[];
}

export interface TradeState {
  signals?: {
    title: string;
    confidence: number;
    createdAt: number;
    metadata?: {
      snap?: { pair?: string; exchange?: string };
      position?: { pair?: string; exchange?: string };
    };
  }[];
  activityLog?: { at: string; text: string }[];
  rawLog?: { at: string; text: string }[];
  tradeStatus?: TradeStatusData;
  tradeState?: {
    closedTrades?: {
      exchange: string;
      pair: string;
      strategyId: string;
      entryPrice: number;
      exitPrice: number;
      volume: number;
      entryTime: number;
      exitTime: number;
      grossPnl: number;
      fee: number;
      netPnl: number;
      priceSamples?: number[];
    }[];
  };
  daemon?: { lastTickAt: string; worker: string; status: string; version?: string };
}

export interface ArbPipelineState {
  enabled?: boolean;
  v2?: {
    mode: string;
    pairs: string[];
    adapters: string[];
    health: Record<string, { ok: boolean; latencyMs?: number }>;
    recentOpportunities: {
      asset?: string;
      buyQuote?: { pair?: string };
      buyVenue: string;
      sellVenue: string;
      expectedNetUsd?: number;
      expectedNetBps?: number;
      executable: boolean;
      observedAt?: number;
      category?: string;
      route?: {
        chain?: string;
        venue?: string;
        hops?: { tokenIn: string; tokenOut: string; fee: number }[];
      } | null;
    }[];
    recentDecisions: { queueId: string; status: string; reason: string; at: number }[];
    circuit: { state: string; trip?: { reason: string; at: number } };
    startedAt: string;
  };
  daemon?: { lastTickAt: string; worker: string; status: string; version?: string };
}

export interface UiSettings {
  tradingEnabled?: boolean | null;
  dailyLossLimitPct?: number | null;
}

export interface PumpfunPosition {
  mint: string;
  name?: string;
  symbol?: string;
  entryMarketCapUsd: number;
  entryAt: number;
  solSpent: number;
  tokenBalance?: number;
  /** Latest fetched USD market cap. Populated by the daemon worker. */
  currentMarketCapUsd?: number;
  /** Rolling history of mcap samples for sparkline rendering. */
  mcapSamples?: number[];
}

export interface PumpfunState {
  enabled?: boolean;
  positions?: PumpfunPosition[];
  activityLog?: { at: string; text: string }[];
  rawLog?: { at: string; text: string }[];
  daemon?: { lastTickAt: string; worker: string; status: string; version?: string };
}
