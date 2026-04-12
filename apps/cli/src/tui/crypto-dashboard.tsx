import React, { useState, useEffect } from 'react';
import { tuiEvents } from './events.js';
import { loadCredentials } from '../auth.js';
import { B1dzClient } from '@b1dz/sdk';
import { getB1dzVersion } from '@b1dz/core';

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
  position: { pair: string; entryPrice: number; volume: number; pnlPct: number; stopPrice: number; elapsed: string } | null;
  dailyPnl: number;
  dailyLossLimitHit: boolean;
  cooldowns: { pair: string; remainingSec: number }[];
  pairsScanned: number;
  ticksPerPair: Record<string, number>;
  lastSignal: string | null;
}

interface TradeState {
  signals: { title: string; confidence: number; createdAt: number }[];
  activityLog: { at: string; text: string }[];
  rawLog?: { at: string; text: string }[];
  tradeStatus: TradeStatusData;
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

  const addLog = (text: string) => {
    setLogs((prev) => {
      const next = [...prev, { at: new Date().toISOString(), text }];
      while (next.length > 50) next.shift();
      return next;
    });
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
    tuiEvents.on('toggle-auto-trade', handler);
    tuiEvents.on('set-log-tab', tabHandler);
    return () => {
      tuiEvents.off('toggle-auto-trade', handler);
      tuiEvents.off('set-log-tab', tabHandler);
    };
  }, []);

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
  const trades = arbState?.recentTrades ?? [];
  const openOrders = arbState?.openOrders ?? [];
  const signals = tradeState?.signals ?? [];

  const btc = prices.find((p) => p.pair === 'BTC-USD' && p.exchange === 'kraken')?.bid;
  const eth = prices.find((p) => p.pair === 'ETH-USD' && p.exchange === 'kraken')?.bid;

  // Trade status from daemon
  const ts = tradeState?.tradeStatus;

  // P/L — only count REALIZED round-trips (matched buy then sell on same pair)
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayTs = todayStart.getTime() / 1000;
  const todayTrades = trades.filter((t) => t.time >= todayTs);

  // Match sells with their preceding buys to compute realized P/L
  let realizedPnl = 0;
  let totalFees = 0;
  const buysByPair = new Map<string, { cost: number; fee: number }>();
  for (const t of [...todayTrades].reverse()) { // oldest first
    const cost = parseFloat(t.cost);
    const fee = parseFloat(t.fee);
    totalFees += fee;
    if (t.type === 'buy') {
      buysByPair.set(t.pair, { cost, fee });
    } else if (t.type === 'sell') {
      const buy = buysByPair.get(t.pair);
      if (buy) {
        realizedPnl += (cost - buy.cost) - fee - buy.fee;
        buysByPair.delete(t.pair);
      }
    }
  }

  const daemonStatus = daemonOnline ? '{green-fg}●{/}' : '{red-fg}●{/}';
  const pos = ts?.position;
  const posStr = pos ? `{cyan-fg}${pos.pair}{/}` : '{white-fg}no position{/}';
  const pnlStr = realizedPnl >= 0 ? `{green-fg}+$${realizedPnl.toFixed(2)}{/}` : `{red-fg}$${realizedPnl.toFixed(2)}{/}`;
  const daemonVer = arbState?.daemon?.version ?? tradeState?.daemon?.version ?? '?';
  const statusText = ` b1dz v${getB1dzVersion()} daemon:v${daemonVer} ${daemonStatus}  ${posStr}  realized:${pnlStr}  fees:$${totalFees.toFixed(2)}  [t]rade [a]ctivity [l]ogs [q]uit`;
  const tabsText = logTab === 'activity'
    ? ' {black-fg}{green-bg} Activity {/} {white-fg} Logs {/}'
    : ' {white-fg} Activity {/} {black-fg}{cyan-bg} Logs {/}';

  // Positions — from daemon tradeStatus (source of truth, not trade history)
  const krakenPairMap: Record<string, string> = {
    XXBTZUSD: 'BTC-USD', XETHZUSD: 'ETH-USD', XZECZUSD: 'ZEC-USD',
    SOLUSD: 'SOL-USD', TAOUSD: 'TAO-USD', ADAUSD: 'ADA-USD',
    FARTCOINUSD: 'FARTCOIN-USD', DOGEUSD: 'DOGE-USD', HYPEUSD: 'HYPE-USD',
    DASHUSD: 'DASH-USD', RAVEUSD: 'RAVE-USD', LINKUSD: 'LINK-USD',
  };
  const posLines: string[] = [];
  if (pos) {
    const currentPrice = prices.find((pr) => {
      const base = pos.pair.split('-')[0];
      return pr.pair.includes(base);
    })?.bid ?? 0;
    const pnlPct = currentPrice > 0 ? ((currentPrice - pos.entryPrice) / pos.entryPrice * 100) : 0;
    const pnlUsd = currentPrice > 0 ? (currentPrice - pos.entryPrice) * pos.volume : 0;
    const pnlColor = pnlPct >= 0 ? '{green-fg}' : '{red-fg}';
    posLines.push(` {cyan-fg}kraken{/}  ${pos.pair.padEnd(14)} ${pos.volume.toFixed(6)} @ $${pos.entryPrice.toFixed(2)}  ${pnlColor}${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}% ($${pnlUsd.toFixed(2)}){/}  stop:$${pos.stopPrice.toFixed(2)}  ${pos.elapsed}`);
  }
  if (posLines.length === 0) {
    posLines.push(' {white-fg}No open positions{/white-fg}');
  }

  // Prices — show top 5 pairs by volume (first in the list)
  const DISPLAY_PAIRS = [...new Set(prices.map((p) => p.pair))].slice(0, 5);
  const priceLines: string[] = ['{bold} Pair             Kraken          Coinbase        Binance{/bold}'];
  for (const pair of DISPLAY_PAIRS) {
    const kr = prices.find((p) => p.pair === pair && p.exchange === 'kraken');
    const cb = prices.find((p) => p.pair === pair && p.exchange === 'coinbase');
    const bn = prices.find((p) => p.pair === pair && p.exchange === 'binance-us');
    const fmt = (v?: number) => v ? `$${v.toFixed(2)}`.padStart(14) : '           -  ';
    priceLines.push(` ${pair.padEnd(16)} ${fmt(kr?.bid)}  ${fmt(cb?.bid)}  ${fmt(bn?.bid)}`);
  }
  if (!daemonOnline) priceLines.push('', ' {red-fg}Daemon offline — waiting for data...{/red-fg}');
  if (apiError) priceLines.push(` {red-fg}API: ${apiError.slice(0, 60)}{/red-fg}`);

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

  // Recent trades (last 24h only)
  const oneDayAgo = Date.now() / 1000 - 86400;
  const recentTrades = trades.filter((t) => t.time >= oneDayAgo);
  const tradeLines: string[] = ['{bold} Recent Trades (24h){/bold}'];
  if (recentTrades.length === 0) {
    tradeLines.push(' {white-fg}No trades in last 24h{/white-fg}');
  } else {
    for (const t of recentTrades.slice(0, 8)) {
      const color = t.type === 'buy' ? '{green-fg}' : '{red-fg}';
      tradeLines.push(` ${color}${t.type.toUpperCase().padEnd(4)}{/} ${t.pair.padEnd(10)} ${parseFloat(t.vol).toFixed(6)} @ $${parseFloat(t.price).toFixed(2)}  fee=$${parseFloat(t.fee).toFixed(4)}  ${timeSince(t.time)}`);
    }
  }

  // Strategy status
  const sigLines: string[] = ['{bold} Strategy Status{/bold}'];
  if (!ts) {
    sigLines.push(' {white-fg}Waiting for daemon...{/white-fg}');
  } else {
    sigLines.push(` Strategies: {cyan-fg}composite{/} (scalp + multi-signal)`);
    sigLines.push(` Pairs scanned: {white-fg}${ts.pairsScanned}{/}`);
    // Show warmup progress for top pairs
    const pairEntries = Object.entries(ts.ticksPerPair).sort((a, b) => b[1] - a[1]).slice(0, 5);
    for (const [pair, ticks] of pairEntries) {
      const ready = ticks >= 20;
      const bar = ready ? '{green-fg}ready{/}' : `{yellow-fg}warming ${ticks}/20{/}`;
      sigLines.push(`  ${pair.padEnd(10)} ${bar}`);
    }
    sigLines.push('');
    if (ts.position) {
      const p = ts.position;
      const pnlColor = p.pnlPct >= 0 ? '{green-fg}' : '{red-fg}';
      sigLines.push(` {bold}POSITION:{/} ${p.pair}`);
      sigLines.push(`  entry: $${p.entryPrice.toFixed(2)}  stop: $${p.stopPrice.toFixed(2)}`);
      sigLines.push(`  ${pnlColor}P/L: ${p.pnlPct >= 0 ? '+' : ''}${p.pnlPct.toFixed(3)}%{/}  time: ${p.elapsed}`);
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
  for (const t of recentTrades) {
    const base = t.pair.replace(/^X/, '').split('USD')[0];
    const price = parseFloat(t.price);
    if (base && price > 0 && !priceOf[base]) priceOf[base] = price;
  }
  if (ts?.position?.entryPrice && ts.position.entryPrice > 0) {
    const base = ts.position.pair.split('-')[0];
    if (base && !priceOf[base]) priceOf[base] = ts.position.entryPrice;
  }

  // Helper: extract all non-zero holdings from a balance map
  const stablecoins = new Set(['USD', 'USDC', 'USDT']);
  function parseBal(bal: Record<string, string>, nameMap?: Record<string, string>) {
    const holdings: { asset: string; amount: number; isStable: boolean; usdValue: number }[] = [];
    for (const [k, v] of Object.entries(bal)) {
      const name = nameMap?.[k] ?? k;
      const val = parseFloat(v);
      if (val < 0.0001) continue;
      const isStable = stablecoins.has(name);
      const usdValue = isStable ? val : val * (priceOf[name] ?? 0);
      holdings.push({ asset: name, amount: val, isStable, usdValue });
    }
    return holdings;
  }

  const krakenHoldings = parseBal(krakenBal, krakenNameMap);
  const binanceHoldings = parseBal(binanceBal);
  const coinbaseHoldings = parseBal(coinbaseBal);

  const sumValue = (h: { usdValue: number }[]) => h.reduce((s, x) => s + x.usdValue, 0);
  const totalValue = sumValue(krakenHoldings) + sumValue(binanceHoldings) + sumValue(coinbaseHoldings);

  function fmtHoldings(holdings: { asset: string; amount: number; isStable: boolean; usdValue: number }[]): string {
    if (holdings.length === 0) return '{white-fg}no data{/}';
    return holdings.map((h) => {
      if (h.isStable) return `$${h.amount.toFixed(2)} ${h.asset}`;
      return h.usdValue > 0
        ? `${h.amount.toFixed(4)} ${h.asset} ($${h.usdValue.toFixed(2)})`
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
    .sort((a, b) => a.at.localeCompare(b.at))
    .slice(-30); // last 30 entries only
  const rawSeen = new Set<string>();
  const daemonRawLog = [...arbRawLog, ...tradeRawLog]
    .filter((l) => {
      if (!l?.at || !l?.text?.trim()) return false;
      const key = `${l.at}:${l.text}`;
      if (rawSeen.has(key)) return false;
      rawSeen.add(key);
      return true;
    })
    .sort((a, b) => a.at.localeCompare(b.at))
    .slice(-60);

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
  const rawLogLines = daemonRawLog.map((l) => {
    const time = formatLogTs(l.at);
    let color = '{white-fg}';
    if (l.text.includes('✗') || l.text.includes('error') || l.text.includes('FAILED')) color = '{red-fg}';
    else if (l.text.includes('[ws]')) color = '{cyan-fg}';
    else if (l.text.includes('[coinbase]') || l.text.includes('[binance]') || l.text.includes('[kraken]')) color = '{yellow-fg}';
    else if (l.text.includes('[trade]')) color = '{green-fg}';
    else if (l.text.includes('[arb]')) color = '{blue-fg}';
    return `{white-fg}${time}{/} ${color}${l.text}{/}`;
  });
  const footerLines = logTab === 'activity' ? activityLines : rawLogLines;

  const posH = Math.min(posLines.length + 2, 5);
  const row1H = Math.min(DISPLAY_PAIRS.length + 3, 8);
  const row2H = Math.min(Math.max(displaySpreads.length + 3, 5), 7);
  const row3H = Math.min(Math.max(recentTrades.length + 2, balLines.length + 2, 6), 9);

  return (
    <>
      <box top={0} left={0} width="100%" height={1} tags={true}
        style={{ bg: 'blue', fg: 'white' }} content={statusText} />

      <box top={1} left={0} width="100%" height={1} tags={true}
        style={{ bg: 'black', fg: 'white' }} content={tabsText} />

      <box label=" Positions " top={2} left={0} width="100%" height={posH}
        border={{ type: 'line' }} tags={true} style={{ border: { fg: 'yellow' } }}
        content={posLines.join('\n')} />

      <box label=" Prices " top={2 + posH} left={0} width="100%" height={row1H}
        border={{ type: 'line' }} tags={true} style={{ border: { fg: 'cyan' } }}
        content={priceLines.join('\n')} />

      <box label=" Arb Spreads " top={2 + posH + row1H} left={0} width="40%" height={row2H}
        border={{ type: 'line' }} tags={true} style={{ border: { fg: 'yellow' } }}
        content={arbLines.join('\n')} />

      <box label=" Open Orders " top={2 + posH + row1H} left="40%" width="30%" height={row2H}
        border={{ type: 'line' }} tags={true} scrollable={true}
        style={{ border: { fg: 'magenta' } }}
        content={orderLines.join('\n')} />

      <box label=" Trade Signals " top={2 + posH + row1H} left="70%" width="30%" height={row2H}
        border={{ type: 'line' }} tags={true} scrollable={true}
        style={{ border: { fg: 'cyan' } }}
        content={sigLines.join('\n')} />

      <box label=" Recent Trades " top={2 + posH + row1H + row2H} left={0} width="55%" height={row3H}
        border={{ type: 'line' }} tags={true} scrollable={true} mouse={true}
        style={{ border: { fg: 'green' } }}
        content={tradeLines.join('\n')} />

      <box label=" Balances " top={2 + posH + row1H + row2H} left="55%" width="45%" height={row3H}
        border={{ type: 'line' }} tags={true} scrollable={true} mouse={true}
        style={{ border: { fg: 'green' } }}
        content={balLines.join('\n')} />

      <box label={logTab === 'activity' ? ' Activity ' : ' Logs '} top={2 + posH + row1H + row2H + row3H} left={0} width="100%"
        height={`100%-${3 + posH + row1H + row2H + row3H}`}
        border={{ type: 'line' }} tags={true} scrollable={true} mouse={true}
        style={{ border: { fg: 'gray' } }}
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
