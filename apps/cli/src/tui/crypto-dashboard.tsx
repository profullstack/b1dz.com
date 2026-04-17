import React, { useState, useEffect, useMemo } from 'react';
import { tuiEvents } from './events.js';
import { loadCredentials } from '../auth.js';
import { B1dzClient } from '@b1dz/sdk';
import { getB1dzVersion } from '@b1dz/core';
import { RealtimeOHLCChartContainer } from './chart/RealtimeOHLCChartContainer.js';
import { setWsLogger, cancelBinanceOrder, closeBinanceHolding } from '@b1dz/source-crypto-arb';
import { fetchNews, openUrl, formatNewsTs, type NewsItem } from './news-feed.js';

// ─── API client (talks to b1dz API, never Supabase directly) ──

import { writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CRED_PATH = join(homedir(), '.config', 'b1dz', 'credentials.json');

function saveCreds(update: { accessToken: string; refreshToken: string }) {
  const current = loadCredentials();
  if (current) {
    writeFileSync(CRED_PATH, JSON.stringify({ ...current, ...update, savedAt: new Date().toISOString() }, null, 2));
  }
}

async function createApiClient(): Promise<B1dzClient | null> {
  const baseUrl = process.env.B1DZ_API_URL;
  const creds = loadCredentials();
  if (!creds || !baseUrl) return null;

  // Refresh token on startup so we always have a valid session
  try {
    const res = await fetch(`${baseUrl}/api/auth/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refresh_token: creds.refreshToken }),
    });
    if (res.ok) {
      const { session } = (await res.json()) as { session?: { access_token: string; refresh_token: string } };
      if (session) {
        creds.accessToken = session.access_token;
        creds.refreshToken = session.refresh_token;
        saveCreds({ accessToken: session.access_token, refreshToken: session.refresh_token });
      }
    }
  } catch {}

  return new B1dzClient({
    baseUrl,
    tokens: { accessToken: creds.accessToken, refreshToken: creds.refreshToken },
    onRefresh: (tokens) => saveCreds(tokens),
  });
}

// ─── Types matching daemon's Supabase payload ──────────────────

interface ArbState {
  prices: { exchange: string; pair: string; bid: number; ask: number }[];
  spreads: { pair: string; spread: number; buyExchange: string; sellExchange: string; profitable: boolean }[];
  krakenBalance: Record<string, string>;
  binanceBalance: Record<string, string>;
  coinbaseBalance: Record<string, string>;
  binanceDetailedBalance?: { asset: string; free: string; locked: string }[];
  binanceOpenOrders?: { symbol: string; orderId: number; side: string; type: string; price: string; origQty: string; executedQty: string; status: string }[];
  recentTrades: { pair: string; type: string; price: string; vol: string; cost: string; fee: string; time: number }[];
  openOrders: { id: string; descr: { type: string; pair: string; price: string; order: string }; vol: string; vol_exec: string; status: string }[];
  rawLog?: { at: string; text: string }[];
  daemon: { lastTickAt: string; worker: string; status: string; version?: string };
}

interface ArbPipelineState {
  enabled: boolean;
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

interface TradeStatusData {
  positions: { exchange: string; pair: string; entryPrice: number; currentPrice: number; volume: number; pnlPct: number; pnlUsd: number; stopPrice: number; elapsed: string }[];
  position: { pair: string; entryPrice: number; currentPrice: number; volume: number; pnlPct: number; pnlUsd: number; stopPrice: number; elapsed: string } | null;
  dailyPnl: number;
  dailyPnlPct: number;
  dailyLossLimitHit: boolean;
  dailyLossLimitPct: number;
  cooldowns: { pair: string; remainingSec: number }[];
  eligiblePairs?: number;
  observedPairs?: number;
  pairsScanned?: number;
  ticksPerPair: Record<string, number>;
  exchangeStates: { exchange: string; readyPairs: number; warmingPairs: number; openPositions: number; blockedReason: string | null }[];
  lastSignal: string | null;
}

interface TradeState {
  signals: {
    title: string;
    confidence: number;
    createdAt: number;
    metadata?: {
      snap?: { pair?: string; exchange?: string };
      position?: { pair?: string; exchange?: string };
    };
  }[];
  activityLog: { at: string; text: string }[];
  rawLog?: { at: string; text: string }[];
  tradeStatus: TradeStatusData;
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
    }[];
  };
  daemon: { lastTickAt: string; worker: string; status: string; version?: string };
}

interface LogEntry {
  at: string;
  text: string;
}

function formatLogTs(isoLike: string): string {
  try {
    const d = new Date(isoLike);
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const min = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    return `${mm}-${dd} ${hh}:${min}:${ss}`;
  } catch {
    return '??-?? ??:??:??';
  }
}

function timeSince(ts: number): string {
  const sec = Math.floor((Date.now() / 1000) - ts);
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  return `${Math.floor(sec / 3600)}h ago`;
}

function safeCount(...values: unknown[]): number {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      return Math.floor(value);
    }
  }
  return 0;
}

const DUST_USD_THRESHOLD = 1;

function formatUsdPrice(value: number): string {
  if (!Number.isFinite(value)) return '-';
  const abs = Math.abs(value);
  // Precision ladder — keep BTC/ETH readable at 2 decimals (cents are
  // plenty) while giving mid-range assets (ICP, LTC, SOL) enough decimals
  // to show tick-level movement. For sub-dollar assets we scale with
  // leading zeros so tiny memecoins still show meaningful change.
  if (abs >= 1000) return value.toFixed(2);   // BTC $75620.67, ETH $3451.23
  if (abs >= 100) return value.toFixed(3);    // SOL $201.234
  if (abs >= 10) return value.toFixed(4);     // LTC $95.1234
  if (abs >= 1) return value.toFixed(4);      // ICP $4.1234
  if (abs >= 0.1) return value.toFixed(5);    // XRP $0.58234
  if (abs >= 0.01) return value.toFixed(6);   // $0.012345
  if (abs >= 0.001) return value.toFixed(7);  // $0.0012345
  if (abs >= 0.0001) return value.toFixed(8); // $0.00012345
  return value.toFixed(10);                    // tiny memecoins
}

function padLeft(value: string, width: number): string {
  return value.length >= width ? value : `${' '.repeat(width - value.length)}${value}`;
}

function padRight(value: string, width: number): string {
  return value.length >= width ? value : `${value}${' '.repeat(width - value.length)}`;
}

const CHART_TIMEFRAMES = ['1m', '5m', '15m', '1h', '4h', '1d', '1w'] as const;
type ChartTimeframe = typeof CHART_TIMEFRAMES[number];
type ClosedTradeRow = NonNullable<NonNullable<TradeState['tradeState']>['closedTrades']>[number];
const CHART_AUTO_CYCLE_MS = 30_000;
const CHART_MANUAL_PAUSE_MS = 5 * 60_000;
const SIGNAL_CANDIDATE_WINDOW_MS = 15 * 60_000;

interface ChartCandidate {
  pair: string;
  exchange?: string;
}

function preferredChartExchange(pair: string, positions: TradeStatusData['positions'], prices: ArbState['prices'], closedTrades: NonNullable<TradeState['tradeState']>['closedTrades'] = []) {
  const priceExchanges = new Set(prices.filter((price) => price.pair === pair).map((price) => price.exchange));
  const open = positions.find((pos) => pos.pair === pair);
  if (open && (priceExchanges.size === 0 || priceExchanges.has(open.exchange))) return open.exchange;
  for (const exchange of ['kraken', 'coinbase', 'binance-us']) {
    if (priceExchanges.has(exchange)) return exchange;
  }
  if (open) return open.exchange;
  const recentClosed = [...closedTrades].sort((a, b) => b.exitTime - a.exitTime).find((trade) => trade.pair === pair);
  return recentClosed?.exchange ?? 'kraken';
}

function toSignalChartCandidate(signal: unknown): ChartCandidate | null {
  const data = signal as {
    title?: string;
    createdAt?: number;
    metadata?: {
      snap?: { pair?: string; exchange?: string };
      position?: { pair?: string; exchange?: string };
    };
  };
  if ((data.createdAt ?? 0) < Date.now() - SIGNAL_CANDIDATE_WINDOW_MS) return null;
  const pair = data.metadata?.snap?.pair
    ?? data.metadata?.position?.pair
    ?? (/^(?:BUY|SELL)\s+([A-Z0-9-]+)/.exec(data.title ?? '')?.[1] ?? null);
  const exchange = data.metadata?.snap?.exchange ?? data.metadata?.position?.exchange;
  return pair ? { pair, exchange } : null;
}

function candidateKey(candidate: ChartCandidate): string {
  return `${candidate.exchange ?? ''}:${candidate.pair}`;
}

function nextChartCandidate(
  candidates: ChartCandidate[],
  currentPair: string | null,
  currentExchange: string | null,
  excludeKey?: string,
): ChartCandidate | null {
  const filtered = excludeKey
    ? candidates.filter((candidate) => candidateKey(candidate) !== excludeKey)
    : candidates;
  if (filtered.length === 0) return null;
  const currentKey = currentPair ? `${currentExchange ?? ''}:${currentPair}` : null;
  const currentIndex = currentKey ? filtered.findIndex((candidate) => candidateKey(candidate) === currentKey) : -1;
  return filtered[(currentIndex + 1 + filtered.length) % filtered.length] ?? filtered[0] ?? null;
}

function ClickablePair({
  top,
  left,
  pair,
  exchange,
  active,
  onSelect,
  width,
}: {
  top: number;
  left: number | string;
  pair: string;
  exchange?: string;
  active?: boolean;
  onSelect: (pair: string, exchange?: string) => void;
  width?: number;
}) {
  return (
    <box
      top={top}
      left={left}
      width={width ?? Math.max(pair.length + 2, 10)}
      height={1}
      mouse={true}
      clickable={true}
      tags={true}
      onClick={() => onSelect(pair, exchange)}
      style={{ bg: active ? 'cyan' : 'black', fg: active ? 'black' : 'white' }}
      content={` ${pair} `}
    />
  );
}

function ActionButton({
  top,
  left,
  label,
  color,
  pending,
  onClick,
}: {
  top: number;
  left: number | string;
  label: string;
  color: 'red' | 'yellow' | 'green';
  pending?: boolean;
  onClick: () => void;
}) {
  const bg = pending ? 'black' : color;
  const fg = pending ? 'yellow' : 'black';
  return (
    <box
      top={top}
      left={left}
      width={label.length + 4}
      height={1}
      mouse={true}
      clickable={true}
      tags={true}
      onClick={onClick}
      style={{ bg, fg }}
      content={` ${pending ? '...' : label} `}
    />
  );
}

// Wrap the whole component in error handling so bad data doesn't crash React
function DashboardInner() {
  const [arbState, setArbState] = useState<ArbState | null>(null);
  const [tradeState, setTradeState] = useState<TradeState | null>(null);
  const [arbPipeState, setArbPipeState] = useState<ArbPipelineState | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [autoTrade, setAutoTrade] = useState(true);
  const [tickCount, setTickCount] = useState(0);
  const [daemonOnline, setDaemonOnline] = useState(false);
  const [apiError, setApiError] = useState<string | null>(null);
  const [logTab, setLogTab] = useState<'activity' | 'logs' | 'news' | 'arb'>('arb');
  const [activityPage, setActivityPage] = useState(0);
  const [rawPage, setRawPage] = useState(0);
  const [news, setNews] = useState<NewsItem[]>([]);
  const [newsPage, setNewsPage] = useState(0);
  const [arbPage, setV2Page] = useState(0);
  const [newsError, setNewsError] = useState<string | null>(null);
  const [chartPair, setChartPair] = useState<string | null>(null);
  const [chartPairB, setChartPairB] = useState<string | null>(null);
  const [chartExchangeA, setChartExchangeA] = useState<string | null>(null);
  const [chartExchangeB, setChartExchangeB] = useState<string | null>(null);
  const [chartTimeframe, setChartTimeframe] = useState<ChartTimeframe>('1m');
  const [showTimeframeMenu, setShowTimeframeMenu] = useState(false);
  const [chartTarget, setChartTarget] = useState<'A' | 'B'>('A');
  const [chartPauseUntilA, setChartPauseUntilA] = useState(0);
  const [chartPauseUntilB, setChartPauseUntilB] = useState(0);
  // Default to ENABLED (override=true) so the daemon trades on first
  // boot without requiring the operator to toggle. Persisted UI state
  // (if any) replaces this default during hydration below.
  const [tradingEnabled, setTradingEnabled] = useState<boolean | null>(true);
  const [dailyLossLimitOverridePct, setDailyLossLimitOverridePct] = useState<number | null>(null);
  const [pendingActions, setPendingActions] = useState<Set<string>>(new Set());
  const [settingsHydrated, setSettingsHydrated] = useState(false);
  const [apiClient, setApiClient] = useState<B1dzClient | null>(null);

  const addLog = (text: string) => {
    setLogs((prev) => {
      const next = [...prev, { at: new Date().toISOString(), text }];
      while (next.length > 50) next.shift();
      return next;
    });
  };

  useEffect(() => {
    setWsLogger((msg) => addLog(msg));
    return () => setWsLogger(null);
  }, []);

  const pauseChart = (target: 'A' | 'B') => {
    const until = Date.now() + CHART_MANUAL_PAUSE_MS;
    if (target === 'A') setChartPauseUntilA(until);
    else setChartPauseUntilB(until);
    addLog(`{cyan-fg}Chart ${target}{/cyan-fg} auto-cycle paused 5m`);
  };

  const unpauseChart = (target: 'A' | 'B') => {
    if (target === 'A') setChartPauseUntilA(0);
    else setChartPauseUntilB(0);
    addLog(`{cyan-fg}Chart ${target}{/cyan-fg} auto-cycle resumed`);
  };

  const toggleChartPause = (target: 'A' | 'B') => {
    const now = Date.now();
    const pausedUntil = target === 'A' ? chartPauseUntilA : chartPauseUntilB;
    if (pausedUntil > now) {
      unpauseChart(target);
    } else {
      pauseChart(target);
    }
  };

  const selectChartPair = (
    next: string,
    exchange?: string,
    opts?: { target?: 'A' | 'B'; manual?: boolean },
  ) => {
    const target = opts?.target ?? chartTarget;
    if (target === 'A') {
      setChartPair(next);
      setChartExchangeA(exchange ?? null);
    } else {
      setChartPairB(next);
      setChartExchangeB(exchange ?? null);
    }
    if (opts?.manual) pauseChart(target);
    setShowTimeframeMenu(false);
    addLog(`{cyan-fg}Chart ${target}{/cyan-fg} pair → ${next}${exchange ? ` @ ${exchange}` : ''}`);
  };

  const selectChartTimeframe = (next: ChartTimeframe) => {
    setChartTimeframe(next);
    setShowTimeframeMenu(false);
    addLog(`{cyan-fg}Chart{/cyan-fg} timeframe → ${next}`);
  };

  // Key events
  useEffect(() => {
    const handler = () => {
      setAutoTrade((prev) => {
        const next = !prev;
        addLog(next ? '{green-fg}Auto-trade ENABLED{/green-fg}' : '{red-fg}Auto-trade DISABLED{/red-fg}');
        return next;
      });
    };
    const tabHandler = (tab: 'activity' | 'logs' | 'news') => setLogTab(tab);
    const pageHandler = (delta: number) => {
      if (logTab === 'activity') setActivityPage((prev) => Math.max(0, prev + delta));
      else if (logTab === 'logs') setRawPage((prev) => Math.max(0, prev + delta));
      else if (logTab === 'arb') setV2Page((prev) => Math.max(0, prev + delta));
      else setNewsPage((prev) => Math.max(0, prev + delta));
    };
    const timeframeHandler = (next: ChartTimeframe) => {
      selectChartTimeframe(next);
    };
    const pairCycleHandler = (delta: number) => {
      setChartPair((current) => {
        const tradePairs = tradeState?.tradeStatus?.ticksPerPair
          ? [...new Set(Object.keys(tradeState.tradeStatus.ticksPerPair).map((key) => key.split(':').slice(1).join(':')))]
          : [];
        const pricePairs = [...new Set((arbState?.prices ?? []).map((price) => price.pair))];
        const pairs = [...new Set([
          ...(tradeState?.tradeStatus?.positions ?? []).map((pos) => pos.pair),
          ...tradePairs,
          ...pricePairs,
        ])];
        if (pairs.length === 0) return current;
        const start = current && pairs.includes(current) ? pairs.indexOf(current) : 0;
        const next = pairs[(start + delta + pairs.length) % pairs.length];
        setShowTimeframeMenu(false);
        setChartExchangeA(null);
        setChartPauseUntilA(0);
        addLog(`{cyan-fg}Chart{/cyan-fg} pair → ${next}`);
        return next;
      });
    };
    const tradingToggleHandler = () => {
      setTradingEnabled((prev) => {
        const next = prev === true ? false : true;
        addLog(next
          ? '{black-fg}{yellow-bg} TRADING ENABLED — bypasses 5% daily loss limit {/}'
          : '{white-fg}{red-bg} TRADING DISABLED — new entries halted {/}');
        return next;
      });
    };
    tuiEvents.on('toggle-auto-trade', handler);
    tuiEvents.on('set-log-tab', tabHandler);
    tuiEvents.on('page-log', pageHandler);
    tuiEvents.on('set-chart-timeframe', timeframeHandler);
    tuiEvents.on('cycle-chart-pair', pairCycleHandler);
    tuiEvents.on('toggle-trading-enabled', tradingToggleHandler);
    return () => {
      tuiEvents.off('toggle-auto-trade', handler);
      tuiEvents.off('set-log-tab', tabHandler);
      tuiEvents.off('page-log', pageHandler);
      tuiEvents.off('set-chart-timeframe', timeframeHandler);
      tuiEvents.off('cycle-chart-pair', pairCycleHandler);
      tuiEvents.off('toggle-trading-enabled', tradingToggleHandler);
    };
  }, [logTab, arbState, tradeState]);

  // ── Hydrate persisted UI settings on mount ──
  useEffect(() => {
    if (!apiClient || settingsHydrated) return;
    let active = true;
    apiClient.storage.get<{
      tradingEnabled?: boolean | null;
      dailyLossLimitPct?: number | null;
      chartPairA?: string | null;
      chartPairB?: string | null;
      chartExchangeA?: string | null;
      chartExchangeB?: string | null;
      chartTimeframe?: ChartTimeframe;
      chartTarget?: 'A' | 'B';
    }>('source-state', 'crypto-ui-settings').then((settings) => {
      if (!active) return;
      if (settings) {
        if (settings.tradingEnabled === true || settings.tradingEnabled === false) {
          setTradingEnabled(settings.tradingEnabled);
        }
        if (typeof settings.dailyLossLimitPct === 'number' && isFinite(settings.dailyLossLimitPct) && settings.dailyLossLimitPct > 0) {
          setDailyLossLimitOverridePct(settings.dailyLossLimitPct);
        }
        if (settings.chartPairA) setChartPair(settings.chartPairA);
        if (settings.chartPairB) setChartPairB(settings.chartPairB);
        if (settings.chartExchangeA) setChartExchangeA(settings.chartExchangeA);
        if (settings.chartExchangeB) setChartExchangeB(settings.chartExchangeB);
        if (settings.chartTimeframe && (CHART_TIMEFRAMES as readonly string[]).includes(settings.chartTimeframe)) {
          setChartTimeframe(settings.chartTimeframe);
        }
        if (settings.chartTarget === 'A' || settings.chartTarget === 'B') {
          setChartTarget(settings.chartTarget);
        }
      }
      setSettingsHydrated(true);
    }).catch(() => {
      setSettingsHydrated(true);
    });
    return () => { active = false; };
  }, [apiClient, settingsHydrated]);

  // ── Persist UI settings on change (debounced) ──
  useEffect(() => {
    if (!apiClient || !settingsHydrated) return;
    const handle = setTimeout(() => {
      apiClient.storage.put('source-state', 'crypto-ui-settings', {
        tradingEnabled,
        dailyLossLimitPct: dailyLossLimitOverridePct,
        chartPairA: chartPair,
        chartPairB,
        chartExchangeA,
        chartExchangeB,
        chartTimeframe,
        chartTarget,
      }).catch((e) => addLog(`{red-fg}Persist settings failed: ${(e as Error).message?.slice(0, 60)}{/red-fg}`));
    }, 500);
    return () => clearTimeout(handle);
  }, [apiClient, settingsHydrated, tradingEnabled, dailyLossLimitOverridePct, chartPair, chartPairB, chartExchangeA, chartExchangeB, chartTimeframe, chartTarget]);

  // Poll API for daemon state
  useEffect(() => {
    let active = true;
    let client: B1dzClient | null = null;
    let seenVersionLog = false;
    let seenDaemonVersion: string | null = null;

    const init = async () => {
      try {
        client = await createApiClient();
        if (!client) {
          addLog('{red-fg}No API credentials — run b1dz login first{/red-fg}');
          return;
        }
        setApiClient(client);
        addLog(`{green-fg}Connected to API{/green-fg} cli=v${getB1dzVersion()}`);
        poll();
      } catch (e) {
        addLog(`{red-fg}API init error: ${(e as Error).message?.slice(0, 60)}{/red-fg}`);
      }
    };

    const poll = async () => {
      if (!client || !active) return;
      try {
        // Sequential to avoid refresh token races
        const arb = await client.storage.get<ArbState>('source-state', 'crypto-arb');
        const trade = await client.storage.get<TradeState>('source-state', 'crypto-trade');

        if (!active) return;
        setApiError(null);

        if (arb) {
          setArbState(arb);
          const apiVersion = client.getApiVersion();
          if (!seenVersionLog && apiVersion) {
            addLog(`{cyan-fg}Version{/cyan-fg} cli=v${getB1dzVersion()} api=v${apiVersion}`);
            seenVersionLog = true;
          }
          if (arb.daemon?.lastTickAt) {
            const age = Date.now() - new Date(arb.daemon.lastTickAt).getTime();
            setDaemonOnline(age < 10000);
          }
          if (arb.daemon?.version && arb.daemon.version !== seenDaemonVersion) {
            addLog(`{cyan-fg}Daemon version{/cyan-fg} ${arb.daemon.worker}=v${arb.daemon.version}`);
            seenDaemonVersion = arb.daemon.version;
          }
        }
        if (trade) {
          setTradeState(trade);
          if (trade.daemon?.version && trade.daemon.version !== seenDaemonVersion) {
            addLog(`{cyan-fg}Daemon version{/cyan-fg} ${trade.daemon.worker}=v${trade.daemon.version}`);
            seenDaemonVersion = trade.daemon.version;
          }
        }

        const v2 = await client.storage.get<ArbPipelineState>('source-state', 'arb-pipeline').catch(() => null);
        if (v2 && active) {
          setArbPipeState(v2);
          if (v2.daemon?.lastTickAt) {
            const age = Date.now() - new Date(v2.daemon.lastTickAt).getTime();
            if (age < 15000) setDaemonOnline(true);
          }
        }

        setTickCount((c) => c + 1);
      } catch (e) {
        const msg = (e as Error).message;
        if (!apiError) addLog(`{red-fg}API: ${msg.slice(0, 80)}{/red-fg}`);
        setApiError(msg);
      }
    };

    init();
    const timer = setInterval(poll, 3000);
    return () => { active = false; clearInterval(timer); };
  }, []);

  // Poll brisk.news every 15s
  useEffect(() => {
    let active = true;
    const ctl = new AbortController();
    const load = async () => {
      try {
        const items = await fetchNews(ctl.signal);
        if (!active) return;
        setNews(items);
        setNewsError(null);
      } catch (e) {
        if (!active) return;
        const msg = (e as Error).message;
        if (msg && msg !== 'The operation was aborted.') setNewsError(msg);
      }
    };
    load();
    const timer = setInterval(load, 15000);
    return () => { active = false; ctl.abort(); clearInterval(timer); };
  }, []);

  // ── Render data ──

  const prices = arbState?.prices ?? [];
  const spreads = arbState?.spreads ?? [];
  const krakenBal = arbState?.krakenBalance ?? {};
  const binanceBal = arbState?.binanceBalance ?? {};
  const coinbaseBal = arbState?.coinbaseBalance ?? {};
  const openOrders = arbState?.openOrders ?? [];
  const signals = tradeState?.signals ?? [];
  const closedTrades = tradeState?.tradeState?.closedTrades ?? [];
  const krakenNameMap: Record<string, string> = {
    ZUSD: 'USD', XXBT: 'BTC', XETH: 'ETH', XXDG: 'DOGE',
    XZEC: 'ZEC', XXRP: 'XRP', XXLM: 'XLM', XXMR: 'XMR',
    XLTC: 'LTC', XADA: 'ADA', XSOL: 'SOL',
  };
  const stablecoins = new Set(['USD', 'USDC', 'USDT']);

  const priceOf: Record<string, number> = {};
  for (const p of prices) {
    if (p.bid > 0) {
      const base = p.pair.split('-')[0];
      if (!priceOf[base]) priceOf[base] = p.bid;
    }
  }

  function parseBal(bal: Record<string, string>, nameMap?: Record<string, string>) {
    const holdings: { asset: string; amount: number; isStable: boolean; unitPrice: number; usdValue: number }[] = [];
    for (const [k, v] of Object.entries(bal)) {
      const name = nameMap?.[k] ?? k;
      const val = parseFloat(v);
      if (val < 0.0001) continue;
      const isStable = stablecoins.has(name);
      const unitPrice = isStable ? 1 : (priceOf[name] ?? 0);
      const usdValue = val * unitPrice;
      holdings.push({ asset: name, amount: val, isStable, unitPrice, usdValue });
    }
    return holdings;
  }

  const btc = prices.find((p) => p.pair === 'BTC-USD' && p.exchange === 'kraken')?.bid;
  const eth = prices.find((p) => p.pair === 'ETH-USD' && p.exchange === 'kraken')?.bid;

  // Trade status from daemon
  const ts = tradeState?.tradeStatus;
  const positions = ts?.positions ?? (ts?.position ? [{ exchange: 'kraken', ...ts.position }] : []);
  const krakenHoldings = parseBal(krakenBal, krakenNameMap);
  const binanceHoldings = parseBal(binanceBal);
  const coinbaseHoldings = parseBal(coinbaseBal);
  const observedPairFallback = ts ? new Set(Object.keys(ts.ticksPerPair ?? {}).map((key) => key.split(':').slice(1).join(':'))).size : 0;
  const eligiblePairs = safeCount(ts?.eligiblePairs, ts?.pairsScanned, observedPairFallback);
  const observedPairs = safeCount(ts?.observedPairs, observedPairFallback, ts?.pairsScanned);

  const realizedPnl = ts?.dailyPnl ?? 0;
  const realizedPnlPct = ts?.dailyPnlPct ?? 0;

  // Fees shown in the header are based on today's closed strategy trades.
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayTsMs = todayStart.getTime();
  const todayClosedTrades = closedTrades.filter((t) => t.exitTime >= todayTsMs);
  let totalFees = 0;
  for (const t of todayClosedTrades) {
    totalFees += t.fee;
  }

  const displayedPositions = [...positions];
  const seenTracked = new Set(positions.map((pos) => `${pos.exchange}:${pos.pair}`));
  for (const [exchange, holdings] of [
    ['kraken', krakenHoldings],
    ['coinbase', coinbaseHoldings],
    ['binance-us', binanceHoldings],
  ] as const) {
    for (const holding of holdings) {
      if (holding.isStable || holding.usdValue < DUST_USD_THRESHOLD) continue;
      const pair = `${holding.asset}-USD`;
      const key = `${exchange}:${pair}`;
      if (seenTracked.has(key)) continue;
      displayedPositions.push({
        exchange,
        pair,
        entryPrice: 0,
        currentPrice: holding.unitPrice,
        volume: holding.amount,
        pnlPct: 0,
        pnlUsd: 0,
        stopPrice: 0,
        elapsed: 'holding',
      });
      seenTracked.add(key);
    }
  }
  const visiblePositions = displayedPositions.filter((pos) => ((pos.currentPrice ?? 0) * (pos.volume ?? 0)) >= DUST_USD_THRESHOLD);

  const daemonStatus = daemonOnline ? '{green-fg}●{/}' : '{red-fg}●{/}';
  const posStr = visiblePositions.length === 0
    ? '{white-fg}no position{/}'
    : visiblePositions.length === 1
      ? `{cyan-fg}${visiblePositions[0].exchange}:${visiblePositions[0].pair}{/}`
      : `{cyan-fg}${visiblePositions.length} positions{/}`;
  const pnlStr = realizedPnl >= 0 ? `{green-fg}+$${realizedPnl.toFixed(2)}{/}` : `{red-fg}$${realizedPnl.toFixed(2)}{/}`;
  const pnlPctStr = realizedPnlPct >= 0 ? `{green-fg}(+${realizedPnlPct.toFixed(2)}%){/}` : `{red-fg}(${realizedPnlPct.toFixed(2)}%){/}`;
  const daemonVer = arbState?.daemon?.version ?? tradeState?.daemon?.version ?? '?';
  // Show the daemon-authoritative value in the badge (that's what's actually
  // enforced). If the user's local override differs, surface it as "pending"
  // so there's no ambiguity about which limit just halted us.
  const daemonLimitPct = ts?.dailyLossLimitPct ?? 5;
  const uiLimitPct = dailyLossLimitOverridePct ?? daemonLimitPct;
  const pendingSuffix = dailyLossLimitOverridePct != null && Math.abs(dailyLossLimitOverridePct - daemonLimitPct) > 0.01
    ? ` {yellow-fg}(pending ${uiLimitPct.toFixed(1)}%){/}`
    : '';
  const currentDailyLimitPct = uiLimitPct;
  const haltStr = ts?.dailyLossLimitHit
    ? `  {black-fg}{yellow-bg} HALTED ${daemonLimitPct.toFixed(1)}% daily limit {/}${pendingSuffix}`
    : `  {white-fg}daily-limit:${daemonLimitPct.toFixed(1)}%{/}${pendingSuffix}`;
  const tradingStr = tradingEnabled === true
    ? `  {black-fg}{green-bg} TRADING: ENABLED (override) {/}`
    : tradingEnabled === false
      ? `  {white-fg}{red-bg} TRADING: DISABLED {/}`
      : '';

  const adjustDailyLimit = (deltaPct: number) => {
    setDailyLossLimitOverridePct((prev) => {
      const current = prev ?? ts?.dailyLossLimitPct ?? 5;
      const next = Math.max(1, Math.min(100, Math.round((current + deltaPct) * 10) / 10));
      addLog(`{yellow-fg}⚙ daily loss limit → ${next.toFixed(1)}% (saves to settings){/}`);
      return next;
    });
  };

  const statusText = ` b1dz v${getB1dzVersion()} daemon:v${daemonVer} ${daemonStatus}  ${posStr}  today:${pnlStr} ${pnlPctStr}${haltStr}${tradingStr}  fees:$${totalFees.toFixed(2)}  [d]isable/enable [t]rade [a]ctivity [l]ogs [q]uit`;

  const chartPairs = [...new Set([
    ...visiblePositions.map((pos) => pos.pair),
    ...Object.keys(ts?.ticksPerPair ?? {}).map((key) => key.split(':').slice(1).join(':')),
    ...prices.map((price) => price.pair),
    ...closedTrades.map((trade) => trade.pair),
  ])].filter(Boolean);
  const activeChartPair = chartPairs.includes(chartPair ?? '') ? chartPair! : (chartPairs[0] ?? 'BTC-USD');
  const preferredPrimaryExchange = preferredChartExchange(activeChartPair, positions, prices, closedTrades);
  const primaryLiveExchanges = new Set(prices.filter((price) => price.pair === activeChartPair).map((price) => price.exchange));
  const chartExchange = chartExchangeA && (primaryLiveExchanges.size === 0 || primaryLiveExchanges.has(chartExchangeA))
    ? chartExchangeA
    : preferredPrimaryExchange;
  const chartPairIdx = chartPairs.indexOf(activeChartPair);
  const fallbackSecondary = chartPairs.length > 1
    ? chartPairs[(Math.max(chartPairIdx, 0) + 1) % chartPairs.length]
    : activeChartPair;
  const secondaryChartPair = chartPairs.includes(chartPairB ?? '') && (chartPairB ?? '') !== activeChartPair
    ? chartPairB!
    : fallbackSecondary;
  const preferredSecondaryExchange = preferredChartExchange(secondaryChartPair, positions, prices, closedTrades);
  const secondaryLiveExchanges = new Set(prices.filter((price) => price.pair === secondaryChartPair).map((price) => price.exchange));
  const secondaryChartExchange = chartExchangeB && (secondaryLiveExchanges.size === 0 || secondaryLiveExchanges.has(chartExchangeB))
    ? chartExchangeB
    : preferredSecondaryExchange;
  const displayPricePairs = [...new Set(prices.map((price) => price.pair))].slice(0, 8);

  useEffect(() => {
    if (!chartPairs.length) return;
    if (!chartPair || !chartPairs.includes(chartPair)) {
      setChartPair(chartPairs[0]);
      setChartExchangeA(null);
    }
  }, [chartPairs, chartPair]);
  useEffect(() => {
    if (!chartPairs.length) return;
    if (!chartPairB || !chartPairs.includes(chartPairB) || chartPairB === activeChartPair) {
      const next = chartPairs.find((pair) => pair !== activeChartPair) ?? activeChartPair;
      setChartPairB(next);
      setChartExchangeB(null);
    }
  }, [chartPairs, chartPairB, activeChartPair]);

  const chartCandidates = useMemo(() => {
    const candidates: ChartCandidate[] = [];
    const seen = new Set<string>();
    for (const pos of visiblePositions) {
      const candidate = { pair: pos.pair, exchange: pos.exchange };
      const key = candidateKey(candidate);
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push(candidate);
    }
    for (const signal of signals) {
      const candidate = toSignalChartCandidate(signal);
      if (!candidate) continue;
      const resolved = {
        pair: candidate.pair,
        exchange: candidate.exchange ?? preferredChartExchange(candidate.pair, positions, prices, closedTrades),
      };
      const key = candidateKey(resolved);
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push(resolved);
    }
    for (const pair of chartPairs) {
      const candidate = {
        pair,
        exchange: preferredChartExchange(pair, positions, prices, closedTrades),
      };
      const key = candidateKey(candidate);
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push(candidate);
    }
    return candidates;
  }, [visiblePositions, signals, positions, prices, closedTrades, chartPairs]);

  useEffect(() => {
    if (chartCandidates.length === 0) return;
    const timer = setInterval(() => {
      const now = Date.now();
      if (chartPauseUntilA <= now) {
        const nextA = nextChartCandidate(chartCandidates, activeChartPair, chartExchange, `${secondaryChartExchange ?? ''}:${secondaryChartPair}`);
        if (nextA && candidateKey(nextA) !== `${chartExchange ?? ''}:${activeChartPair}`) {
          selectChartPair(nextA.pair, nextA.exchange, { target: 'A' });
        }
      }
      if (chartPauseUntilB <= now) {
        const nextB = nextChartCandidate(chartCandidates, secondaryChartPair, secondaryChartExchange, `${chartExchange ?? ''}:${activeChartPair}`);
        if (nextB && candidateKey(nextB) !== `${secondaryChartExchange ?? ''}:${secondaryChartPair}`) {
          selectChartPair(nextB.pair, nextB.exchange, { target: 'B' });
        }
      }
    }, CHART_AUTO_CYCLE_MS);
    return () => clearInterval(timer);
  }, [
    chartCandidates,
    activeChartPair,
    chartExchange,
    secondaryChartPair,
    secondaryChartExchange,
    chartPauseUntilA,
    chartPauseUntilB,
  ]);

  const chartAPaused = chartPauseUntilA > Date.now();
  const chartBPaused = chartPauseUntilB > Date.now();
  const chartAPauseLabel = chartAPaused ? 'paused' : 'auto';
  const chartBPauseLabel = chartBPaused ? 'paused' : 'auto';

  // Positions — from daemon tradeStatus (source of truth, not trade history)
  const posLines: string[] = [
    '{bold} Exch        Pair             Coins        Value       Entry        Last         PnL               Stop        Age{/bold}',
  ];
  for (const pos of visiblePositions) {
    const volume = typeof pos.volume === 'number' && Number.isFinite(pos.volume) ? pos.volume : 0;
    const currentPrice = typeof pos.currentPrice === 'number' && Number.isFinite(pos.currentPrice) ? pos.currentPrice : 0;
    const currentValue = volume * currentPrice;
    const entryPrice = typeof pos.entryPrice === 'number' && Number.isFinite(pos.entryPrice) ? pos.entryPrice : 0;
    const pnlPct = typeof pos.pnlPct === 'number' && Number.isFinite(pos.pnlPct) ? pos.pnlPct : 0;
    const pnlUsd = typeof pos.pnlUsd === 'number' && Number.isFinite(pos.pnlUsd) ? pos.pnlUsd : 0;
    const stopPrice = typeof pos.stopPrice === 'number' && Number.isFinite(pos.stopPrice) ? pos.stopPrice : 0;
    const pnlColor = pnlPct >= 0 ? '{green-fg}' : '{red-fg}';
    const exColor = pos.exchange === 'kraken' ? '{cyan-fg}' : pos.exchange === 'coinbase' ? '{magenta-fg}' : '{yellow-fg}';
    const exchangeCell = padRight(pos.exchange, 10);
    const pairCell = padRight(pos.pair, 16);
    const volumeCell = padLeft(volume.toFixed(6), 11);
    const valueCell = padLeft(`$${currentValue.toFixed(2)}`, 11);
    const lastCell = padLeft(`$${formatUsdPrice(currentPrice)}`, 11);
    if (entryPrice > 0) {
      const entryCell = padLeft(`$${formatUsdPrice(entryPrice)}`, 11);
      const pnlText = `${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}% ($${pnlUsd.toFixed(2)})`;
      const pnlCell = padLeft(pnlText, 18);
      const stopCell = padLeft(`$${formatUsdPrice(stopPrice)}`, 11);
      const ageCell = padLeft(pos.elapsed ?? '-', 8);
      posLines.push(` ${exColor}${exchangeCell}{/} ${pairCell} ${volumeCell} ${valueCell} ${entryCell} ${lastCell} ${pnlColor}${pnlCell}{/} ${stopCell} ${ageCell}`);
    } else {
      const statusCell = padRight('untracked holding', 18);
      posLines.push(` ${exColor}${exchangeCell}{/} ${pairCell} ${volumeCell} ${valueCell} ${padLeft('-', 11)} ${lastCell} {white-fg}${statusCell}{/} ${padLeft('-', 11)} ${padLeft(pos.elapsed ?? '-', 8)}`);
    }
  }
  if (visiblePositions.length === 0) {
    posLines.push(' {white-fg}No open positions{/white-fg}');
  }

  // Holdings — per-exchange breakdown with free/locked and inline [close]/[cancel] actions.
  // Binance has detailed free/locked + open orders. Kraken/Coinbase show totals only.
  const binanceDetailed = arbState?.binanceDetailedBalance ?? [];
  const binanceOpenOrdersRich = arbState?.binanceOpenOrders ?? [];

  type HoldingAction =
    | { kind: 'close-binance'; asset: string }
    | { kind: 'cancel-binance-order'; symbol: string; orderId: number };
  interface HoldingRow { text: string; action?: HoldingAction }
  const holdingRows: HoldingRow[] = [];

  function fmtAmount(n: number): string {
    if (n === 0) return '0';
    if (Math.abs(n) >= 1) return n.toFixed(4);
    return n.toFixed(8).replace(/0+$/, '').replace(/\.$/, '');
  }

  // A row earns its line only if it has a non-trivial value OR it locks funds
  // OR it's an open order. Dust gets silently filtered so the box stays small.
  const DUST = 0.10;

  // Column widths — visible cell widths. ANSI/blessed tags wrap the padded
  // text so the tag itself doesn't throw alignment off.
  const EXCH_W = 9;   // 'binance ', 'kraken  ', 'coinbase'
  const ASSET_W = 6;  // asset ticker
  const FREE_W = 26;
  const LOCKED_W = 22;
  function exchCell(name: string, color: string): string {
    return `{${color}-fg}${padRight(name, EXCH_W)}{/}`;
  }

  // Binance: detailed rows with locked column and [close] on non-stable free balances.
  for (const b of binanceDetailed) {
    const free = parseFloat(b.free);
    const locked = parseFloat(b.locked);
    const isStable = stablecoins.has(b.asset);
    const unit = isStable ? 1 : (priceOf[b.asset] ?? 0);
    const usdValue = free * unit;
    const lockedUsd = locked * unit;
    if (usdValue < DUST && lockedUsd < DUST) continue;
    const freeStr = `${fmtAmount(free)}${isStable ? '' : ` ($${usdValue.toFixed(2)})`}`;
    const lockedStr = locked > 0 ? `${fmtAmount(locked)}${isStable ? '' : ` ($${lockedUsd.toFixed(2)})`}` : '-';
    const text = ` ${exchCell('binance', 'yellow')} ${padRight(b.asset, ASSET_W)} free=${padRight(freeStr, FREE_W)} locked=${padRight(lockedStr, LOCKED_W)}`;
    const canClose = !isStable && free > 0 && unit > 0 && usdValue >= DUST;
    holdingRows.push({
      text,
      action: canClose ? { kind: 'close-binance', asset: b.asset } : undefined,
    });
  }

  for (const h of krakenHoldings) {
    if (h.usdValue < DUST) continue;
    const freeStr = `${fmtAmount(h.amount)}${h.isStable ? '' : ` ($${h.usdValue.toFixed(2)})`}`;
    holdingRows.push({
      text: ` ${exchCell('kraken', 'cyan')} ${padRight(h.asset, ASSET_W)} free=${padRight(freeStr, FREE_W)} locked=${padRight('-', LOCKED_W)}`,
    });
  }

  for (const h of coinbaseHoldings) {
    if (h.usdValue < DUST) continue;
    const freeStr = `${fmtAmount(h.amount)}${h.isStable ? '' : ` ($${h.usdValue.toFixed(2)})`}`;
    holdingRows.push({
      text: ` ${exchCell('coinbase', 'magenta')} ${padRight(h.asset, ASSET_W)} free=${padRight(freeStr, FREE_W)} locked=${padRight('-', LOCKED_W)}`,
    });
  }

  if (binanceOpenOrdersRich.length > 0) {
    for (const o of binanceOpenOrdersRich) {
      const remaining = parseFloat(o.origQty) - parseFloat(o.executedQty);
      const price = parseFloat(o.price);
      const notional = remaining * price;
      const text = ` ${exchCell('binance', 'yellow')} ${padRight(o.symbol, ASSET_W)} ${o.side} ${o.type} qty=${o.origQty} @$${o.price} locks=$${notional.toFixed(2)}`;
      holdingRows.push({ text, action: { kind: 'cancel-binance-order', symbol: o.symbol, orderId: o.orderId } });
    }
  }

  if (holdingRows.length === 0) {
    holdingRows.push({ text: ' {white-fg}No holdings (or waiting for daemon — 60s cadence){/}' });
  }

  const holdingsLines = holdingRows.map((r) => r.text);

  async function runAction(id: string, fn: () => Promise<void>) {
    if (pendingActions.has(id)) return;
    setPendingActions((prev) => new Set(prev).add(id));
    try {
      await fn();
    } catch (e) {
      addLog(`{red-fg}✗ ${id}: ${(e as Error).message.slice(0, 100)}{/}`);
    } finally {
      setPendingActions((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }

  const onCloseBinanceHolding = (asset: string) => {
    const id = `close-binance:${asset}`;
    void runAction(id, async () => {
      addLog(`{yellow-fg}⚡ closing Binance ${asset} at market...{/}`);
      const res = await closeBinanceHolding(asset);
      addLog(`{green-fg}✓ Binance ${asset} sold: orderId=${res.orderId} status=${res.status} executed=${res.executedQty}{/}`);
    });
  };

  const onCancelBinanceOrder = (symbol: string, orderId: number) => {
    const id = `cancel-binance:${orderId}`;
    void runAction(id, async () => {
      addLog(`{yellow-fg}⚡ cancelling Binance ${symbol} order ${orderId}...{/}`);
      await cancelBinanceOrder(symbol, orderId);
      addLog(`{green-fg}✓ Binance ${symbol} order ${orderId} cancelled{/}`);
    });
  };

  // Arb spreads — show top 5
  const displaySpreads = spreads.filter((s) => s?.pair && s?.spread != null).slice(0, 5);
  const arbLines: string[] = ['{bold} Pair       Spread    Route                 Status{/bold}'];
  for (const s of displaySpreads) {
    const spread = s.spread ?? 0;
    const color = s.profitable ? '{green-fg}' : '{white-fg}';
    const status = s.profitable ? '{green-fg}✓ PROFIT{/green-fg}' : '{white-fg}below fees{/white-fg}';
    const route = s.buyExchange ? `${s.buyExchange}→${s.sellExchange}` : '---';
    arbLines.push(` ${(s.pair ?? '').padEnd(10)} ${color}${spread.toFixed(4)}%{/}  ${route.padEnd(22)} ${status}`);
  }

  // Open orders
  const orderLines: string[] = ['{bold} Open Orders{/bold}'];
  if (openOrders.length === 0) {
    orderLines.push(' {white-fg}None{/white-fg}');
  } else {
    for (const o of openOrders.slice(0, 5)) {
      orderLines.push(` ${o.descr.type.toUpperCase()} ${o.descr.pair} @ $${o.descr.price}  ${o.status}`);
    }
  }

  // Closed trades (last 24h) — strategy round-trips, not raw exchange fills.
  const oneDayAgoMs = Date.now() - 86400_000;
  const recentClosedTrades = closedTrades.filter((t) => t.exitTime >= oneDayAgoMs);
  const recentClosedRows = [...recentClosedTrades].sort((a, b) => b.exitTime - a.exitTime).slice(0, 8);
  const tradeLines: string[] = ['{bold} Closed Trades (24h){/bold}'];
  if (recentClosedTrades.length === 0) {
    tradeLines.push(' {white-fg}No closed trades in last 24h{/white-fg}');
  } else {
    for (const t of recentClosedRows) {
      const color = t.netPnl >= 0 ? '{green-fg}' : '{red-fg}';
      tradeLines.push(` ${color}${t.exchange.padEnd(10)}{/} ${t.pair.padEnd(10)} ${t.volume.toFixed(6)}  ${t.strategyId.padEnd(10)} net:${t.netPnl >= 0 ? '+' : ''}$${t.netPnl.toFixed(2)}`);
      tradeLines.push(`   entry:$${t.entryPrice.toFixed(2)} exit:$${t.exitPrice.toFixed(2)} gross:$${t.grossPnl.toFixed(2)} fee:$${t.fee.toFixed(2)}  ${timeSince(Math.floor(t.exitTime / 1000))}`);
    }
  }

  // Strategy status
  const sigLines: string[] = ['{bold} Strategy Status{/bold}'];
  if (!ts) {
    sigLines.push(' {white-fg}Waiting for daemon...{/white-fg}');
  } else {
    sigLines.push(` Strategies: {cyan-fg}composite{/} (scalp + multi-signal)`);
    sigLines.push(` Pairs: {white-fg}${eligiblePairs}{/} eligible  {white-fg}${observedPairs}{/} observed`);
    const pairEntries = Object.entries(ts.ticksPerPair).sort((a, b) => b[1] - a[1]).slice(0, 3);
    if (pairEntries.length > 0) {
      const warmupSummary = pairEntries
        .map(([pair, ticks]) => `${pair}:${ticks >= 20 ? 'ready' : `${ticks}/20`}`)
        .join('  ');
      sigLines.push(` Warmups: ${warmupSummary}`);
    }
    for (const s of ts.exchangeStates ?? []) {
      const mode = s.blockedReason
        ? `{red-fg}${s.blockedReason}{/}`
        : s.warmingPairs > 0
          ? `{yellow-fg}warming{/}`
          : `{green-fg}ready{/}`;
      sigLines.push(` ${s.exchange.padEnd(10)} ${mode}  r:${s.readyPairs} w:${s.warmingPairs} o:${s.openPositions}`);
    }
    if (positions.length > 0) {
      sigLines.push(` Positions: {white-fg}${positions.length}{/}`);
      for (const p of positions.slice(0, 3)) {
        sigLines.push(`  ${p.exchange}:${p.pair} entry:$${formatUsdPrice(p.entryPrice)} now:$${formatUsdPrice(p.currentPrice)} stop:$${formatUsdPrice(p.stopPrice)} time:${p.elapsed}`);
      }
    } else {
      sigLines.push(` {white-fg}No open position — scanning for entry...{/white-fg}`);
    }
    if (ts.dailyLossLimitHit) {
      sigLines.push(` {red-fg}⚠ DAILY LOSS LIMIT HIT ($${ts.dailyPnl.toFixed(2)} / ${ts.dailyPnlPct.toFixed(2)}%) — trading halted{/red-fg}`);
    }
    if (ts.cooldowns.length > 0) {
      for (const c of ts.cooldowns) {
        sigLines.push(` {yellow-fg}↻ ${c.pair} cooldown ${c.remainingSec}s{/yellow-fg}`);
      }
    }
  }

  // Balances — simple per-exchange summary
  const sumValue = (h: { usdValue: number }[]) => h.reduce((s, x) => s + x.usdValue, 0);
  const totalValue = sumValue(krakenHoldings) + sumValue(binanceHoldings) + sumValue(coinbaseHoldings);

  function fmtHoldings(holdings: { asset: string; amount: number; isStable: boolean; unitPrice: number; usdValue: number }[]): string {
    if (holdings.length === 0) return '{white-fg}no data{/}';
    return holdings.map((h) => {
      if (h.isStable) return `${h.amount.toFixed(2)} ${h.asset} ($${h.usdValue.toFixed(2)})`;
      return h.unitPrice > 0 && h.usdValue > 0.01
        ? `${h.amount.toFixed(4)} ${h.asset} @ $${formatUsdPrice(h.unitPrice)} ($${h.usdValue.toFixed(2)})`
        : `${h.amount.toFixed(4)} ${h.asset}`;
    }).join(' + ');
  }

  const balLines: string[] = [];
  balLines.push(` {cyan-fg}Kraken{/}    ${fmtHoldings(krakenHoldings)}`);
  balLines.push(` {yellow-fg}Binance{/}   ${fmtHoldings(binanceHoldings)}`);
  balLines.push(` {magenta-fg}Coinbase{/}  ${fmtHoldings(coinbaseHoldings)}`);
  // Total
  balLines.push(' ─────────────────────────');
  balLines.push(` {bold}Total:    $${totalValue.toFixed(2)}{/bold}`);

  // Activity log — merge arb + trade logs, deduplicate, filter blanks
  const arbLog = ((arbState as unknown as Record<string, unknown>)?.activityLog ?? []) as { at: string; text: string }[];
  const tradeLog = tradeState?.activityLog ?? [];
  const arbRawLog = arbState?.rawLog ?? [];
  const tradeRawLog = tradeState?.rawLog ?? [];
  const seen = new Set<string>();
  const daemonLog = [...arbLog, ...tradeLog]
    .filter((l) => {
      if (!l?.at || !l?.text?.trim()) return false;
      // Dedup by timestamp+text
      const key = `${l.at}:${l.text}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.at.localeCompare(b.at));
  const daemonRawLog = [...arbRawLog, ...tradeRawLog]
    .filter((l) => !!l?.at && !!l?.text?.trim())
    .sort((a, b) => a.at.localeCompare(b.at))
    .slice(-300);

  const activityLines = [
    ...daemonLog.map((l) => {
      const time = formatLogTs(l.at);
      let color = '{white-fg}';
      if (l.text.includes('BUY') || l.text.includes('✓') || l.text.includes('EXECUTED')) color = '{green-fg}';
      else if (l.text.includes('SELL') || l.text.includes('✗') || l.text.includes('SKIPPED')) color = '{red-fg}';
      else if (l.text.includes('SIGNAL') || l.text.includes('⚡') || l.text.includes('ENTRY')) color = '{yellow-fg}';
      else if (l.text.includes('[ws]')) color = '{cyan-fg}';
      else if (l.text.includes('[arb]')) color = '{blue-fg}';
      return `{white-fg}${time}{/} ${color}${l.text}{/}`;
    }),
    ...logs.map((l) => `{white-fg}${formatLogTs(l.at)}{/} {white-fg}${l.text}{/}`),
  ];
  const rawLogLines = [
    ...daemonRawLog.map((l) => {
      const time = formatLogTs(l.at);
      let color = '{white-fg}';
      if (l.text.includes('✗') || l.text.includes('error') || l.text.includes('FAILED')) color = '{red-fg}';
      else if (l.text.includes('[ws]')) color = '{cyan-fg}';
      else if (l.text.includes('[coinbase]') || l.text.includes('[binance]') || l.text.includes('[kraken]')) color = '{yellow-fg}';
      else if (l.text.includes('[trade]')) color = '{green-fg}';
      else if (l.text.includes('[arb]')) color = '{blue-fg}';
      return `{white-fg}${time}{/} ${color}${l.text}{/}`;
    }),
    ...logs.map((l) => `{white-fg}${formatLogTs(l.at)}{/} {white-fg}${l.text}{/}`),
  ];

  const posH = Math.min(posLines.length + 2, 7);
  const holdingsH = Math.min(holdingsLines.length + 2, 9);
  const row2H = Math.min(Math.max(displaySpreads.length + 4, 8), 10);
  const row3H = Math.min(Math.max(tradeLines.length + 2, balLines.length + 2, 6), 11);
  const screenRows = process.stdout.rows ?? 40;
  const chartH = Math.max(12, Math.min(20, screenRows - 2 - posH - holdingsH - row2H - row3H - 6));
  const holdingsTop = 2 + posH;
  const chartTop = 2 + posH + holdingsH;
  const primaryChartWidthPct = 44;
  const secondaryChartWidthPct = 44;
  const chartControlsWidthPct = 12;
  const screenCols = process.stdout.columns ?? 120;
  const primaryChartRenderWidth = Math.max(34, Math.floor(screenCols * (primaryChartWidthPct / 100)) - 3);
  const secondaryChartRenderWidth = Math.max(34, Math.floor(screenCols * (secondaryChartWidthPct / 100)) - 3);
  const footerTop = 2 + posH + holdingsH + chartH + row2H + row3H;
  const footerH = Math.max(8, screenRows - footerTop);
  const footerPageSize = Math.max(1, footerH - 2);

  function paginateNewestFirst(lines: string[], pageFromStart: number) {
    const newestFirst = [...lines].reverse();
    const totalPages = Math.max(1, Math.ceil(lines.length / footerPageSize));
    const safePage = Math.min(pageFromStart, totalPages - 1);
    const start = safePage * footerPageSize;
    const end = start + footerPageSize;
    return {
      pageLines: newestFirst.slice(start, end),
      page: safePage,
      totalPages,
    };
  }

  const pagedActivity = paginateNewestFirst(activityLines, activityPage);
  const pagedRaw = paginateNewestFirst(rawLogLines, rawPage);

  const newsTotalPages = Math.max(1, Math.ceil(news.length / footerPageSize));
  const newsSafePage = Math.min(newsPage, newsTotalPages - 1);
  const newsStart = newsSafePage * footerPageSize;
  const pagedNews = news.slice(newsStart, newsStart + footerPageSize);

  let footerLines: string[];
  let footerPage: number;
  let footerPages: number;
  let footerTabLabel: string;
  const arbPipeLines: string[] = (() => {
    if (!arbPipeState?.v2) return ['{yellow-fg}arb pipeline not started{/}'];
    const v = arbPipeState.v2;
    const hdr = `{cyan-fg}mode={/}{bold}${v.mode}{/bold}  {cyan-fg}pairs={/}${v.pairs.length}  {cyan-fg}adapters={/}${v.adapters.join(',')}  {cyan-fg}circuit={/}${v.circuit.state === 'closed' ? '{green-fg}closed{/}' : '{red-fg}OPEN ' + (v.circuit.trip?.reason ?? '') + '{/}'}`;
    const lines = [hdr, ''];
    if (v.recentOpportunities.length === 0) {
      lines.push('{white-fg}No opportunities yet — scanning...{/}');
    } else {
      lines.push('{bold}Recent Opportunities:{/bold}');
      for (const o of v.recentOpportunities.slice(-15)) {
        const ts = o.observedAt ? new Date(o.observedAt).toLocaleTimeString('en-US', { hour12: false }) : '??:??:??';
        const exec = o.executable ? '{green-fg}✓{/}' : '{red-fg}✗{/}';
        const netStr = `net={bold}$${(o.expectedNetUsd ?? 0).toFixed(2)}{/bold} ${(o.expectedNetBps ?? 0).toFixed(0)}bps`;
        if (o.category === 'dex_triangular' && o.route?.hops?.length) {
          const path = o.route.hops.map((h) => h.tokenOut).join('→');
          const anchor = o.route.hops[0]?.tokenIn ?? '?';
          const chain = o.route.chain ?? '?';
          lines.push(`{white-fg}${ts}{/} ${exec} {magenta-fg}TRI{/} ${anchor}→${path} {yellow-fg}${o.route.venue}@${chain}{/} ${netStr}`);
        } else {
          const pair = o.buyQuote?.pair ?? o.asset ?? '?';
          lines.push(`{white-fg}${ts}{/} ${exec} ${pair} {yellow-fg}${o.buyVenue ?? '?'}→${o.sellVenue ?? '?'}{/} ${netStr}`);
        }
      }
    }
    if (v.recentDecisions.length > 0) {
      lines.push('', '{bold}Recent Decisions:{/bold}');
      // Collapse consecutive-duplicate decisions (same status + reason)
      // into one row with a (×N) multiplier. Without this, a steady
      // stream of "no executor can handle category=cex_cex ..." rejects
      // fills the whole tab and drowns out actual fills.
      type Row = { ts: string; status: string; reason: string; count: number };
      const collapsed: Row[] = [];
      for (const d of v.recentDecisions) {
        const ts = new Date(d.at).toLocaleTimeString('en-US', { hour12: false });
        const last = collapsed[collapsed.length - 1];
        if (last && last.status === d.status && last.reason === d.reason) {
          last.count++;
          last.ts = ts; // advance to latest timestamp in the run
        } else {
          collapsed.push({ ts, status: d.status, reason: d.reason, count: 1 });
        }
      }
      for (const row of collapsed.slice(-10)) {
        const color = row.status === 'filled' ? '{green-fg}' : row.status === 'rejected' ? '{red-fg}' : '{yellow-fg}';
        const multiplier = row.count > 1 ? ` {white-fg}(×${row.count}){/}` : '';
        lines.push(`{white-fg}${row.ts}{/} ${color}${row.status}{/} ${row.reason}${multiplier}`);
      }
    }
    return lines;
  })();
  const pagedArbPipe = paginateNewestFirst(arbPipeLines, arbPage);

  if (logTab === 'activity') {
    footerLines = pagedActivity.pageLines;
    footerPage = pagedActivity.page;
    footerPages = pagedActivity.totalPages;
    footerTabLabel = 'Activity';
  } else if (logTab === 'logs') {
    footerLines = pagedRaw.pageLines;
    footerPage = pagedRaw.page;
    footerPages = pagedRaw.totalPages;
    footerTabLabel = 'Logs';
  } else if (logTab === 'arb') {
    footerLines = pagedArbPipe.pageLines;
    footerPage = pagedArbPipe.page;
    footerPages = pagedArbPipe.totalPages;
    footerTabLabel = 'Arb Pipeline';
  } else {
    footerLines = [];
    footerPage = newsSafePage;
    footerPages = newsTotalPages;
    footerTabLabel = 'News';
  }
  const footerLabel = `${footerTabLabel}  page ${footerPage + 1}/${footerPages}  ([ ] or PgUp/PgDn, C-b/C-f)`;

  return (
    <>
      <box top={0} left={0} width="100%" height={1} tags={true}
        style={{ bg: 'blue', fg: 'white' }} content={statusText} />
      <box
        top={0}
        left={'100%-14' as any}
        width={3}
        height={1}
        mouse={true}
        clickable={true}
        tags={true}
        onClick={() => adjustDailyLimit(-5)}
        style={{ bg: 'red', fg: 'white' }}
        content=" - "
      />
      <box
        top={0}
        left={'100%-10' as any}
        width={6}
        height={1}
        tags={true}
        style={{ bg: 'blue', fg: 'white' }}
        content={` ${currentDailyLimitPct.toFixed(1).padStart(4, ' ')}%`}
      />
      <box
        top={0}
        left={'100%-4' as any}
        width={3}
        height={1}
        mouse={true}
        clickable={true}
        tags={true}
        onClick={() => adjustDailyLimit(5)}
        style={{ bg: 'green', fg: 'black' }}
        content=" + "
      />

      <box top={1} left={0} width="100%" height={1}
        style={{ bg: 'black', fg: 'white' }} />
      <box
        top={1}
        left={1}
        width={12}
        height={1}
        mouse={true}
        clickable={true}
        onClick={() => setLogTab('activity')}
        tags={true}
        style={{ bg: logTab === 'activity' ? 'green' : 'black', fg: logTab === 'activity' ? 'black' : 'white' }}
        content=" Activity " />
      <box
        top={1}
        left={14}
        width={8}
        height={1}
        mouse={true}
        clickable={true}
        onClick={() => setLogTab('logs')}
        tags={true}
        style={{ bg: logTab === 'logs' ? 'cyan' : 'black', fg: logTab === 'logs' ? 'black' : 'white' }}
        content=" Logs " />
      <box
        top={1}
        left={23}
        width={8}
        height={1}
        mouse={true}
        clickable={true}
        onClick={() => setLogTab('news')}
        tags={true}
        style={{ bg: logTab === 'news' ? 'magenta' : 'black', fg: logTab === 'news' ? 'black' : 'white' }}
        content=" News " />
      <box
        top={1}
        left={32}
        width={6}
        height={1}
        mouse={true}
        clickable={true}
        onClick={() => setLogTab('arb')}
        tags={true}
        style={{ bg: logTab === 'arb' ? 'yellow' : 'black', fg: logTab === 'arb' ? 'black' : 'white' }}
        content=" Arb " />

      <box label=" Positions " top={2} left={0} width="100%" height={posH}
        border={{ type: 'line' }} tags={true} style={{ border: { fg: 'yellow' } }}
        content={posLines.join('\n')} />
      {displayedPositions.map((pos, index) => (
        <ClickablePair
          key={`pos-pair-${pos.exchange}-${pos.pair}`}
          top={4 + index}
          left={13}
          pair={pos.pair}
          exchange={pos.exchange}
          active={pos.pair === activeChartPair}
          onSelect={(nextPair, exchange) => selectChartPair(nextPair, exchange, { manual: true })}
          width={pos.pair.length + 2}
        />
      ))}

      <box label=" Holdings " top={holdingsTop} left={0} width="100%" height={holdingsH}
        border={{ type: 'line' }} tags={true} scrollable={true} mouse={true}
        style={{ border: { fg: 'green' } }}
        content={holdingsLines.join('\n')} />
      {holdingRows.map((row, index) => {
        if (!row.action) return null;
        // Only render a button if its row is visible inside the box.
        // Box content area = holdingsH - 2 (borders top + bottom).
        if (index >= holdingsH - 2) return null;
        const rowTop = holdingsTop + 1 + index;
        if (row.action.kind === 'close-binance') {
          const asset = row.action.asset;
          const id = `close-binance:${asset}`;
          return (
            <ActionButton
              key={`holding-action-${id}`}
              top={rowTop}
              left={'100%-10' as any}
              label="close"
              color="red"
              pending={pendingActions.has(id)}
              onClick={() => onCloseBinanceHolding(asset)}
            />
          );
        }
        const { symbol, orderId } = row.action;
        const id = `cancel-binance:${orderId}`;
        return (
          <ActionButton
            key={`holding-action-${id}`}
            top={rowTop}
            left={'100%-11' as any}
            label="cancel"
            color="yellow"
            pending={pendingActions.has(id)}
            onClick={() => onCancelBinanceOrder(symbol, orderId)}
          />
        );
      })}

      <RealtimeOHLCChartContainer
        top={chartTop}
        left={0}
        height={chartH}
        width={primaryChartRenderWidth}
        boxWidth={`${primaryChartWidthPct}%`}
        label={` Chart A  ${activeChartPair} @ ${chartExchange}  TF:${chartTimeframe} `}
        pair={activeChartPair}
        exchange={chartExchange}
        timeframe={chartTimeframe}
        positions={positions as any}
        closedTrades={closedTrades as any}
        mouse={true}
        clickable={true}
        onClick={() => {
          setChartTarget('A');
          toggleChartPause('A');
        }}
      />
      <RealtimeOHLCChartContainer
        top={chartTop}
        left={`${primaryChartWidthPct}%` as any}
        height={chartH}
        width={secondaryChartRenderWidth}
        boxWidth={`${secondaryChartWidthPct}%`}
        label={` Chart B  ${secondaryChartPair} @ ${secondaryChartExchange}  TF:${chartTimeframe} `}
        pair={secondaryChartPair}
        exchange={secondaryChartExchange}
        timeframe={chartTimeframe}
        positions={positions as any}
        closedTrades={closedTrades as any}
        mouse={true}
        clickable={true}
        onClick={() => {
          setChartTarget('B');
          toggleChartPause('B');
        }}
      />
      <box
        top={chartTop}
        left={`${primaryChartWidthPct + secondaryChartWidthPct}%`}
        width={`${chartControlsWidthPct}%`}
        height={chartH}
        border={{ type: 'line' }}
        tags={true}
        style={{ border: { fg: 'cyan' }, bg: 'black', fg: 'white' }}
        content={[
          ` ${chartPairIdx >= 0 ? chartPairIdx + 1 : 0}/${chartPairs.length || 1}`,
          ` A:${activeChartPair}`,
          ` B:${secondaryChartPair}`,
          ` tgt ${chartTarget}`,
          '',
          ' TF',
        ].join('\n')}
      />
      <box
        top={chartTop + 1}
        left={`${primaryChartWidthPct + secondaryChartWidthPct}%+2`}
        width={5}
        height={1}
        mouse={true}
        clickable={true}
        tags={true}
        onClick={() => setChartTarget('A')}
        style={{ bg: chartTarget === 'A' ? 'green' : 'black', fg: chartTarget === 'A' ? 'black' : 'white' }}
        content=" A "
      />
      <box
        top={chartTop + 1}
        left={`${primaryChartWidthPct + secondaryChartWidthPct}%+8`}
        width={5}
        height={1}
        mouse={true}
        clickable={true}
        tags={true}
        onClick={() => setChartTarget('B')}
        style={{ bg: chartTarget === 'B' ? 'green' : 'black', fg: chartTarget === 'B' ? 'black' : 'white' }}
        content=" B "
      />
      <ClickablePair
        top={chartTop + 2}
        left={`${primaryChartWidthPct + secondaryChartWidthPct}%+2`}
        pair={activeChartPair}
        active={chartTarget === 'A'}
        onSelect={(pair) => {
          setChartTarget('A');
          selectChartPair(pair, undefined, { target: 'A', manual: true });
        }}
        width={Math.max(activeChartPair.length + 2, 12)}
      />
      <ClickablePair
        top={chartTop + 3}
        left={`${primaryChartWidthPct + secondaryChartWidthPct}%+2`}
        pair={secondaryChartPair}
        active={chartTarget === 'B'}
        onSelect={(pair) => {
          setChartTarget('B');
          selectChartPair(pair, undefined, { target: 'B', manual: true });
        }}
        width={Math.max(secondaryChartPair.length + 2, 12)}
      />
      <box
        top={chartTop + 5}
        left={`${primaryChartWidthPct + secondaryChartWidthPct}%+2`}
        width={12}
        height={1}
        mouse={true}
        clickable={true}
        tags={true}
        onClick={() => setShowTimeframeMenu((prev) => !prev)}
        style={{ bg: 'blue', fg: 'white' }}
        content={` TF:${chartTimeframe} ▼ `}
      />
      {showTimeframeMenu && (
        <box
          top={chartTop + 6}
          left={`${primaryChartWidthPct + secondaryChartWidthPct}%+2`}
          width={12}
          height={CHART_TIMEFRAMES.length + 2}
          border={{ type: 'line' }}
          style={{ border: { fg: 'cyan' }, bg: 'black', fg: 'white' }}
        >
          {CHART_TIMEFRAMES.map((tf, index) => (
            <box
              key={`tf-${tf}`}
              top={1 + index}
              left={1}
              width={8}
              height={1}
              mouse={true}
              clickable={true}
              tags={true}
              onClick={() => selectChartTimeframe(tf)}
              style={{ bg: tf === chartTimeframe ? 'cyan' : 'black', fg: tf === chartTimeframe ? 'black' : 'white' }}
              content={` ${tf} `}
            />
          ))}
        </box>
      )}
      <box
        top={chartTop + 5}
        left={`${primaryChartWidthPct + secondaryChartWidthPct}%+16`}
        width={Math.max(12, Math.floor(((process.stdout.columns ?? 120) * chartControlsWidthPct) / 100) - 18)}
        height={chartH - 6}
        scrollable={true}
        mouse={true}
        keys={true}
        vi={true}
        alwaysScroll={true}
        tags={true}
        style={{ bg: 'black', fg: 'white' }}
      >
        {displayPricePairs.map((pair, index) => (
          <ClickablePair
            key={`chart-pair-${pair}`}
            top={index}
            left={0}
            pair={pair}
            active={pair === activeChartPair}
            onSelect={(nextPair, exchange) => selectChartPair(nextPair, exchange, { manual: true })}
            width={Math.max(pair.length + 2, 10)}
          />
        ))}
      </box>

      <box label=" Arb Spreads " top={2 + posH + holdingsH + chartH} left={0} width="40%" height={row2H}
        border={{ type: 'line' }} tags={true} style={{ border: { fg: 'yellow' } }}
        content={arbLines.join('\n')} />
      {displaySpreads.map((s, index) => (
        <ClickablePair
          key={`spread-pair-${s.pair}-${index}`}
          top={3 + posH + holdingsH + chartH + index}
          left={2}
          pair={s.pair}
          exchange={s.buyExchange || undefined}
          active={s.pair === activeChartPair}
          onSelect={(nextPair, exchange) => selectChartPair(nextPair, exchange, { manual: true })}
          width={s.pair.length + 2}
        />
      ))}

      <box label=" Open Orders " top={2 + posH + holdingsH + chartH} left="40%" width="30%" height={row2H}
        border={{ type: 'line' }} tags={true} scrollable={true}
        style={{ border: { fg: 'magenta' } }}
        content={orderLines.join('\n')} />

      <box label=" Trade Signals " top={2 + posH + holdingsH + chartH} left="70%" width="30%" height={row2H}
        border={{ type: 'line' }} tags={true} scrollable={true} mouse={true} keys={true} vi={true} alwaysScroll={true}
        scrollbar={{ ch: ' ', track: { bg: 'gray' }, style: { bg: 'cyan' } }}
        style={{ border: { fg: 'cyan' } }}
        content={sigLines.join('\n')} />

      <box label=" Closed Trades " top={2 + posH + chartH + row2H} left={0} width="55%" height={row3H}
        border={{ type: 'line' }} tags={true} scrollable={true} mouse={true}
        style={{ border: { fg: 'green' } }}
        content={tradeLines.join('\n')} />
      {recentClosedRows.map((trade: ClosedTradeRow, index: number) => (
        <ClickablePair
          key={`closed-pair-${trade.exchange}-${trade.pair}-${trade.exitTime}`}
          top={3 + posH + holdingsH + chartH + row2H + (index * 2)}
          left={13}
          pair={trade.pair}
          exchange={trade.exchange}
          active={trade.pair === activeChartPair}
          onSelect={(nextPair, exchange) => selectChartPair(nextPair, exchange, { manual: true })}
          width={trade.pair.length + 2}
        />
      ))}

      <box label=" Balances " top={2 + posH + chartH + row2H} left="55%" width="45%" height={row3H}
        border={{ type: 'line' }} tags={true} scrollable={true} mouse={true}
        style={{ border: { fg: 'green' } }}
        content={balLines.join('\n')} />

      <box label={` ${footerLabel} `} top={footerTop} left={0} width="100%"
        height={footerH}
        border={{ type: 'line' }} tags={true} scrollable={true} mouse={true}
        style={{ border: { fg: logTab === 'arb' ? 'yellow' : logTab === 'news' ? 'magenta' : 'gray' }, bg: 'black', fg: 'white' }}
        content={logTab === 'news'
          ? (news.length === 0
              ? (newsError ? ` {red-fg}news error: ${newsError.slice(0, 80)}{/red-fg}` : ' Loading crypto news...')
              : '')
          : (footerLines.join('\n') || (logTab === 'arb' ? ' Waiting for arb pipeline data...' : logTab === 'activity' ? ' Waiting for daemon data...' : ' Waiting for raw logs...'))} />
      {logTab === 'news' && pagedNews.map((item, index) => (
        <box
          key={`news-row-${newsSafePage}-${index}-${item.uuid}`}
          top={footerTop + 1 + index}
          left={1}
          width={'100%-3' as any}
          height={1}
          mouse={true}
          clickable={true}
          tags={true}
          onClick={() => openUrl(item.url)}
          style={{ bg: 'black', fg: 'white', hover: { bg: 'blue' } }}
          content={` {white-fg}${formatNewsTs(item.publishedAt)}{/}  {cyan-fg}${(item.source || '').slice(0, 14).padEnd(14)}{/}  ${item.title}`}
        />
      ))}
    </>
  );
}

class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: string | null }> {
  state = { error: null as string | null };
  static getDerivedStateFromError(e: Error) { return { error: e.message }; }
  componentDidCatch(e: Error) { console.error('Dashboard error:', e.message, e.stack); }
  render() {
    if (this.state.error) {
      return React.createElement('box', {
        top: 0, left: 0, width: '100%', height: '100%', tags: true,
        content: `{red-fg}Dashboard error: ${this.state.error}{/red-fg}\n\nPress q to quit.`,
      });
    }
    return this.props.children;
  }
}

export function CryptoDashboard() {
  return (
    <ErrorBoundary>
      <DashboardInner />
    </ErrorBoundary>
  );
}
