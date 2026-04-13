import React, { useState, useEffect } from 'react';
import { tuiEvents } from './events.js';
import { loadCredentials } from '../auth.js';
import { B1dzClient } from '@b1dz/sdk';
import { getB1dzVersion } from '@b1dz/core';
import { RealtimeOHLCChartContainer } from './chart/RealtimeOHLCChartContainer.js';

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
  recentTrades: { pair: string; type: string; price: string; vol: string; cost: string; fee: string; time: number }[];
  openOrders: { id: string; descr: { type: string; pair: string; price: string; order: string }; vol: string; vol_exec: string; status: string }[];
  rawLog?: { at: string; text: string }[];
  daemon: { lastTickAt: string; worker: string; status: string; version?: string };
}

interface TradeStatusData {
  positions: { exchange: string; pair: string; entryPrice: number; currentPrice: number; volume: number; pnlPct: number; pnlUsd: number; stopPrice: number; elapsed: string }[];
  position: { pair: string; entryPrice: number; currentPrice: number; volume: number; pnlPct: number; pnlUsd: number; stopPrice: number; elapsed: string } | null;
  dailyPnl: number;
  dailyLossLimitHit: boolean;
  cooldowns: { pair: string; remainingSec: number }[];
  eligiblePairs?: number;
  observedPairs?: number;
  pairsScanned?: number;
  ticksPerPair: Record<string, number>;
  exchangeStates: { exchange: string; readyPairs: number; warmingPairs: number; openPositions: number; blockedReason: string | null }[];
  lastSignal: string | null;
}

interface TradeState {
  signals: { title: string; confidence: number; createdAt: number }[];
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

function formatUsdPrice(value: number): string {
  if (!Number.isFinite(value)) return '-';
  if (Math.abs(value) >= 1000) return value.toFixed(2);
  if (Math.abs(value) >= 1) return value.toFixed(2);
  if (Math.abs(value) >= 0.1) return value.toFixed(4);
  if (Math.abs(value) >= 0.01) return value.toFixed(5);
  return value.toFixed(6);
}

const CHART_TIMEFRAMES = ['1m', '5m', '15m', '1h', '4h', '1d', '1w'] as const;
type ChartTimeframe = typeof CHART_TIMEFRAMES[number];
type ClosedTradeRow = NonNullable<NonNullable<TradeState['tradeState']>['closedTrades']>[number];

function preferredChartExchange(pair: string, positions: TradeStatusData['positions'], prices: ArbState['prices'], closedTrades: NonNullable<TradeState['tradeState']>['closedTrades'] = []) {
  const open = positions.find((pos) => pos.pair === pair);
  if (open) return open.exchange;
  const priceExchanges = new Set(prices.filter((price) => price.pair === pair).map((price) => price.exchange));
  for (const exchange of ['kraken', 'coinbase', 'binance-us']) {
    if (priceExchanges.has(exchange)) return exchange;
  }
  const recentClosed = [...closedTrades].sort((a, b) => b.exitTime - a.exitTime).find((trade) => trade.pair === pair);
  return recentClosed?.exchange ?? 'kraken';
}

function ClickablePair({
  top,
  left,
  pair,
  active,
  onSelect,
  width,
}: {
  top: number;
  left: number | string;
  pair: string;
  active?: boolean;
  onSelect: (pair: string) => void;
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
      onClick={() => onSelect(pair)}
      style={{ bg: active ? 'cyan' : 'black', fg: active ? 'black' : 'white' }}
      content={` ${pair} `}
    />
  );
}

// Wrap the whole component in error handling so bad data doesn't crash React
function DashboardInner() {
  const [arbState, setArbState] = useState<ArbState | null>(null);
  const [tradeState, setTradeState] = useState<TradeState | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [autoTrade, setAutoTrade] = useState(true);
  const [tickCount, setTickCount] = useState(0);
  const [daemonOnline, setDaemonOnline] = useState(false);
  const [apiError, setApiError] = useState<string | null>(null);
  const [logTab, setLogTab] = useState<'activity' | 'logs'>('activity');
  const [activityPage, setActivityPage] = useState(0);
  const [rawPage, setRawPage] = useState(0);
  const [chartPair, setChartPair] = useState<string | null>(null);
  const [chartTimeframe, setChartTimeframe] = useState<ChartTimeframe>('1m');
  const [showTimeframeMenu, setShowTimeframeMenu] = useState(false);

  const addLog = (text: string) => {
    setLogs((prev) => {
      const next = [...prev, { at: new Date().toISOString(), text }];
      while (next.length > 50) next.shift();
      return next;
    });
  };

  const selectChartPair = (next: string) => {
    setChartPair(next);
    setShowTimeframeMenu(false);
    addLog(`{cyan-fg}Chart{/cyan-fg} pair → ${next}`);
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
    const tabHandler = (tab: 'activity' | 'logs') => setLogTab(tab);
    const pageHandler = (delta: number) => {
      if (logTab === 'activity') {
        setActivityPage((prev) => Math.max(0, prev + delta));
      } else {
        setRawPage((prev) => Math.max(0, prev + delta));
      }
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
        addLog(`{cyan-fg}Chart{/cyan-fg} pair → ${next}`);
        return next;
      });
    };
    tuiEvents.on('toggle-auto-trade', handler);
    tuiEvents.on('set-log-tab', tabHandler);
    tuiEvents.on('page-log', pageHandler);
    tuiEvents.on('set-chart-timeframe', timeframeHandler);
    tuiEvents.on('cycle-chart-pair', pairCycleHandler);
    return () => {
      tuiEvents.off('toggle-auto-trade', handler);
      tuiEvents.off('set-log-tab', tabHandler);
      tuiEvents.off('page-log', pageHandler);
      tuiEvents.off('set-chart-timeframe', timeframeHandler);
      tuiEvents.off('cycle-chart-pair', pairCycleHandler);
    };
  }, [logTab, arbState, tradeState]);

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

  // ── Render data ──

  const prices = arbState?.prices ?? [];
  const spreads = arbState?.spreads ?? [];
  const krakenBal = arbState?.krakenBalance ?? {};
  const binanceBal = arbState?.binanceBalance ?? {};
  const coinbaseBal = arbState?.coinbaseBalance ?? {};
  const openOrders = arbState?.openOrders ?? [];
  const signals = tradeState?.signals ?? [];
  const closedTrades = tradeState?.tradeState?.closedTrades ?? [];

  const btc = prices.find((p) => p.pair === 'BTC-USD' && p.exchange === 'kraken')?.bid;
  const eth = prices.find((p) => p.pair === 'ETH-USD' && p.exchange === 'kraken')?.bid;

  // Trade status from daemon
  const ts = tradeState?.tradeStatus;
  const positions = ts?.positions ?? (ts?.position ? [{ exchange: 'kraken', ...ts.position }] : []);
  const observedPairFallback = ts ? new Set(Object.keys(ts.ticksPerPair ?? {}).map((key) => key.split(':').slice(1).join(':'))).size : 0;
  const eligiblePairs = safeCount(ts?.eligiblePairs, ts?.pairsScanned, observedPairFallback);
  const observedPairs = safeCount(ts?.observedPairs, observedPairFallback, ts?.pairsScanned);

  const realizedPnl = ts?.dailyPnl ?? 0;

  // Fees shown in the header are based on today's closed strategy trades.
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayTsMs = todayStart.getTime();
  const todayClosedTrades = closedTrades.filter((t) => t.exitTime >= todayTsMs);
  let totalFees = 0;
  for (const t of todayClosedTrades) {
    totalFees += t.fee;
  }

  const daemonStatus = daemonOnline ? '{green-fg}●{/}' : '{red-fg}●{/}';
  const posStr = positions.length === 0
    ? '{white-fg}no position{/}'
    : positions.length === 1
      ? `{cyan-fg}${positions[0].exchange}:${positions[0].pair}{/}`
      : `{cyan-fg}${positions.length} positions{/}`;
  const pnlStr = realizedPnl >= 0 ? `{green-fg}+$${realizedPnl.toFixed(2)}{/}` : `{red-fg}$${realizedPnl.toFixed(2)}{/}`;
  const daemonVer = arbState?.daemon?.version ?? tradeState?.daemon?.version ?? '?';
  const statusText = ` b1dz v${getB1dzVersion()} daemon:v${daemonVer} ${daemonStatus}  ${posStr}  today:${pnlStr}  fees:$${totalFees.toFixed(2)}  [t]rade [a]ctivity [l]ogs [q]uit`;

  const chartPairs = [...new Set([
    ...positions.map((pos) => pos.pair),
    ...Object.keys(ts?.ticksPerPair ?? {}).map((key) => key.split(':').slice(1).join(':')),
    ...prices.map((price) => price.pair),
    ...closedTrades.map((trade) => trade.pair),
  ])].filter(Boolean);
  const activeChartPair = chartPairs.includes(chartPair ?? '') ? chartPair! : (chartPairs[0] ?? 'BTC-USD');
  const chartExchange = preferredChartExchange(activeChartPair, positions, prices, closedTrades);
  const chartPairIdx = chartPairs.indexOf(activeChartPair);
  const displayPricePairs = [...new Set(prices.map((price) => price.pair))].slice(0, 8);

  useEffect(() => {
    if (!chartPairs.length) return;
    if (!chartPair || !chartPairs.includes(chartPair)) {
      setChartPair(chartPairs[0]);
    }
  }, [chartPairs, chartPair]);

  // Positions — from daemon tradeStatus (source of truth, not trade history)
  const posLines: string[] = [];
  for (const pos of positions) {
    const pnlColor = pos.pnlPct >= 0 ? '{green-fg}' : '{red-fg}';
    const exColor = pos.exchange === 'kraken' ? '{cyan-fg}' : pos.exchange === 'coinbase' ? '{magenta-fg}' : '{yellow-fg}';
    posLines.push(` ${exColor}${pos.exchange}{/}  ${pos.pair.padEnd(14)} ${pos.volume.toFixed(6)} @ $${formatUsdPrice(pos.entryPrice)}  now:$${formatUsdPrice(pos.currentPrice)}  ${pnlColor}${pos.pnlPct >= 0 ? '+' : ''}${pos.pnlPct.toFixed(2)}% ($${pos.pnlUsd.toFixed(2)}){/}  stop:$${formatUsdPrice(pos.stopPrice)}  ${pos.elapsed}`);
  }
  if (posLines.length === 0) {
    posLines.push(' {white-fg}No open positions{/white-fg}');
  }

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
      sigLines.push(` {red-fg}⚠ DAILY LOSS LIMIT HIT ($${ts.dailyPnl.toFixed(2)}) — trading halted{/red-fg}`);
    }
    if (ts.cooldowns.length > 0) {
      for (const c of ts.cooldowns) {
        sigLines.push(` {yellow-fg}↻ ${c.pair} cooldown ${c.remainingSec}s{/yellow-fg}`);
      }
    }
  }

  // Balances — simple per-exchange summary
  const krakenNameMap: Record<string, string> = {
    ZUSD: 'USD', XXBT: 'BTC', XETH: 'ETH', XXDG: 'DOGE',
    XZEC: 'ZEC', XXRP: 'XRP', XXLM: 'XLM', XXMR: 'XMR',
    XLTC: 'LTC', XADA: 'ADA', XSOL: 'SOL',
  };
  const priceOf: Record<string, number> = {};
  for (const p of prices) {
    if (p.bid > 0) {
      const base = p.pair.split('-')[0];
      // Keep the first price we see (prefer kraken)
      if (!priceOf[base]) priceOf[base] = p.bid;
    }
  }

  // Helper: extract all non-zero holdings from a balance map
  const stablecoins = new Set(['USD', 'USDC', 'USDT']);
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

  const krakenHoldings = parseBal(krakenBal, krakenNameMap);
  const binanceHoldings = parseBal(binanceBal);
  const coinbaseHoldings = parseBal(coinbaseBal);

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
  const row2H = Math.min(Math.max(displaySpreads.length + 4, 8), 10);
  const row3H = Math.min(Math.max(tradeLines.length + 2, balLines.length + 2, 6), 11);
  const screenRows = process.stdout.rows ?? 40;
  const chartH = Math.max(8, Math.min(14, screenRows - 2 - posH - row2H - row3H - 8));
  const chartTop = 2 + posH;
  const footerTop = 2 + posH + chartH + row2H + row3H;
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
  const footerLines = logTab === 'activity' ? pagedActivity.pageLines : pagedRaw.pageLines;
  const footerPage = logTab === 'activity' ? pagedActivity.page : pagedRaw.page;
  const footerPages = logTab === 'activity' ? pagedActivity.totalPages : pagedRaw.totalPages;
  const footerLabel = `${logTab === 'activity' ? 'Activity' : 'Logs'}  page ${footerPage + 1}/${footerPages}  ([ ] or PgUp/PgDn, C-b/C-f)`;

  return (
    <>
      <box top={0} left={0} width="100%" height={1} tags={true}
        style={{ bg: 'blue', fg: 'white' }} content={statusText} />

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

      <box label=" Positions " top={2} left={0} width="100%" height={posH}
        border={{ type: 'line' }} tags={true} style={{ border: { fg: 'yellow' } }}
        content={posLines.join('\n')} />
      {positions.map((pos, index) => (
        <ClickablePair
          key={`pos-pair-${pos.exchange}-${pos.pair}`}
          top={3 + index}
          left={13}
          pair={pos.pair}
          active={pos.pair === activeChartPair}
          onSelect={selectChartPair}
          width={pos.pair.length + 2}
        />
      ))}

      <RealtimeOHLCChartContainer
        top={chartTop}
        left={0}
        height={chartH}
        width={(process.stdout.columns ?? 120) - 4}
        label={` OHLC Chart  ${activeChartPair} @ ${chartExchange}  TF:${chartTimeframe}  Pair ${chartPairIdx >= 0 ? chartPairIdx + 1 : 0}/${chartPairs.length || 1}  [1-7] tf [,/.] pair `}
        pair={activeChartPair}
        exchange={chartExchange}
        timeframe={chartTimeframe}
        positions={positions as any}
        closedTrades={closedTrades as any}
      />
      <ClickablePair
        top={chartTop}
        left={3}
        pair={activeChartPair}
        active={true}
        onSelect={selectChartPair}
        width={activeChartPair.length + 2}
      />
      <box
        top={chartTop}
        left={18}
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
          top={chartTop + 1}
          left={18}
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
        top={chartTop}
        left={32}
        width={Math.min((process.stdout.columns ?? 120) - 40, 80)}
        height={1}
        mouse={true}
        tags={true}
        style={{ bg: 'black', fg: 'white' }}
      >
        {displayPricePairs.map((pair, index) => (
          <ClickablePair
            key={`chart-pair-${pair}`}
            top={0}
            left={index * 12}
            pair={pair}
            active={pair === activeChartPair}
            onSelect={selectChartPair}
            width={Math.max(pair.length + 2, 10)}
          />
        ))}
      </box>

      <box label=" Arb Spreads " top={2 + posH + chartH} left={0} width="40%" height={row2H}
        border={{ type: 'line' }} tags={true} style={{ border: { fg: 'yellow' } }}
        content={arbLines.join('\n')} />
      {displaySpreads.map((s, index) => (
        <ClickablePair
          key={`spread-pair-${s.pair}-${index}`}
          top={3 + posH + chartH + index}
          left={2}
          pair={s.pair}
          active={s.pair === activeChartPair}
          onSelect={selectChartPair}
          width={s.pair.length + 2}
        />
      ))}

      <box label=" Open Orders " top={2 + posH + chartH} left="40%" width="30%" height={row2H}
        border={{ type: 'line' }} tags={true} scrollable={true}
        style={{ border: { fg: 'magenta' } }}
        content={orderLines.join('\n')} />

      <box label=" Trade Signals " top={2 + posH + chartH} left="70%" width="30%" height={row2H}
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
          top={3 + posH + chartH + row2H + (index * 2)}
          left={13}
          pair={trade.pair}
          active={trade.pair === activeChartPair}
          onSelect={selectChartPair}
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
        style={{ border: { fg: 'gray' }, bg: 'black', fg: 'white' }}
        content={footerLines.join('\n') || (logTab === 'activity' ? ' Waiting for daemon data...' : ' Waiting for raw logs...')} />
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
