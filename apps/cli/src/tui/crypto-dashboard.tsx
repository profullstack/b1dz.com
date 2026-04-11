import React, { useState, useEffect } from 'react';
import { tuiEvents } from './index.js';
import { loadCredentials } from '../auth.js';
import { B1dzClient } from '@b1dz/sdk';

// ─── API client (talks to b1dz API, never Supabase directly) ──

function createApiClient(): B1dzClient | null {
  const creds = loadCredentials();
  const baseUrl = process.env.B1DZ_API_URL;
  if (!creds || !baseUrl) return null;
  return new B1dzClient({
    baseUrl,
    tokens: { accessToken: creds.accessToken, refreshToken: creds.refreshToken },
    onRefresh: (tokens) => {
      // Persist refreshed tokens so they survive restarts
      const { writeFileSync } = require('node:fs') as typeof import('node:fs');
      const current = loadCredentials();
      if (current) {
        writeFileSync(
          require('node:os').homedir() + '/.config/b1dz/credentials.json',
          JSON.stringify({ ...current, accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, savedAt: new Date().toISOString() }, null, 2),
        );
      }
    },
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
  daemon: { lastTickAt: string; worker: string; status: string };
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
  tradeStatus: TradeStatusData;
  daemon: { lastTickAt: string; worker: string; status: string };
}

interface LogEntry {
  time: string;
  text: string;
}

function timeStr(): string {
  return new Date().toLocaleTimeString('en-US', { hour12: false });
}

function timeSince(ts: number): string {
  const sec = Math.floor((Date.now() / 1000) - ts);
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  return `${Math.floor(sec / 3600)}h ago`;
}

export function CryptoDashboard() {
  const [arbState, setArbState] = useState<ArbState | null>(null);
  const [tradeState, setTradeState] = useState<TradeState | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [autoTrade, setAutoTrade] = useState(true);
  const [tickCount, setTickCount] = useState(0);
  const [daemonOnline, setDaemonOnline] = useState(false);
  const [apiError, setApiError] = useState<string | null>(null);

  const addLog = (text: string) => {
    setLogs((prev) => {
      const next = [...prev, { time: timeStr(), text }];
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
    tuiEvents.on('toggle-auto-trade', handler);
    return () => { tuiEvents.off('toggle-auto-trade', handler); };
  }, []);

  // Poll API for daemon state
  useEffect(() => {
    const client = createApiClient();
    if (!client) {
      addLog('{red-fg}No API credentials — run b1dz login first{/red-fg}');
      return;
    }
    let active = true;

    const poll = async () => {
      try {
        // Read both source states through the API
        const [arb, trade] = await Promise.all([
          client.storage.get<ArbState>('source-state', 'crypto-arb'),
          client.storage.get<TradeState>('source-state', 'crypto-trade'),
        ]);

        if (!active) return;
        setApiError(null);

        if (arb) {
          setArbState(arb);
          if (arb.daemon?.lastTickAt) {
            const age = Date.now() - new Date(arb.daemon.lastTickAt).getTime();
            setDaemonOnline(age < 10000);
          }
        }
        if (trade) {
          setTradeState(trade);
        }

        setTickCount((c) => c + 1);
      } catch (e) {
        const msg = (e as Error).message;
        if (!apiError) addLog(`{red-fg}API: ${msg.slice(0, 80)}{/red-fg}`);
        setApiError(msg);
      }
    };

    poll();
    const timer = setInterval(poll, 2000);
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

  // P/L — only realized (matched buy+sell pairs), not open positions
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayTs = todayStart.getTime() / 1000;
  const todayTrades = trades.filter((t) => t.time >= todayTs);
  let totalFees = 0;
  for (const t of todayTrades) totalFees += parseFloat(t.fee);

  // Realized P/L from daemon's tradeStatus (tracks actual closed trades)
  const realizedPnl = ts?.dailyPnl ?? 0;

  // Open position unrealized P/L
  const pos = ts?.position;
  let unrealizedPnl = 0;
  if (pos) {
    const currentPrice = prices.find((p) => p.pair === pos.pair)?.bid ?? 0;
    if (currentPrice > 0) {
      unrealizedPnl = (currentPrice - pos.entryPrice) * pos.volume;
    }
  }

  const daemonStatus = daemonOnline ? '{green-fg}●{/}' : '{red-fg}●{/}';
  const posStr = pos ? `{cyan-fg}${pos.pair}{/}` : '{gray-fg}no position{/}';
  const pnlStr = realizedPnl >= 0 ? `{green-fg}+$${realizedPnl.toFixed(2)}{/}` : `{red-fg}$${realizedPnl.toFixed(2)}{/}`;
  const unrealStr = pos ? (unrealizedPnl >= 0 ? ` unreal:{green-fg}+$${unrealizedPnl.toFixed(2)}{/}` : ` unreal:{red-fg}$${unrealizedPnl.toFixed(2)}{/}`) : '';
  const statusText = ` b1dz crypto ${daemonStatus}  ${posStr}  P/L:${pnlStr}${unrealStr}  fees:$${totalFees.toFixed(2)}  [t]rade [q]uit`;

  // Prices — show top 5 pairs by volume (first in the list)
  const DISPLAY_PAIRS = [...new Set(prices.map((p) => p.pair))].slice(0, 5);
  const priceLines: string[] = ['{bold} Pair       Kraken Bid      Coinbase Bid   Binance Bid{/bold}'];
  for (const pair of DISPLAY_PAIRS) {
    const kr = prices.find((p) => p.pair === pair && p.exchange === 'kraken');
    const cb = prices.find((p) => p.pair === pair && p.exchange === 'coinbase');
    const bn = prices.find((p) => p.pair === pair && p.exchange === 'binance-us');
    const fmt = (v?: number) => v ? `$${v.toFixed(2)}`.padStart(12) : '         -  ';
    priceLines.push(` ${pair.padEnd(10)} ${fmt(kr?.bid)}  ${fmt(cb?.bid)}  ${fmt(bn?.bid)}`);
  }
  if (!daemonOnline) priceLines.push('', ' {red-fg}Daemon offline — run: pnpm dev:daemon{/red-fg}');
  if (apiError) priceLines.push(` {red-fg}API: ${apiError.slice(0, 60)}{/red-fg}`);

  // Arb spreads — show top 5
  const displaySpreads = spreads.slice(0, 5);
  const arbLines: string[] = ['{bold} Pair       Spread    Route                 Status{/bold}'];
  for (const s of displaySpreads) {
    const color = s.profitable ? '{green-fg}' : '{white-fg}';
    const status = s.profitable ? '{green-fg}✓ PROFIT{/green-fg}' : '{gray-fg}below fees{/gray-fg}';
    const route = s.buyExchange ? `${s.buyExchange}→${s.sellExchange}` : '---';
    arbLines.push(` ${s.pair.padEnd(10)} ${color}${s.spread.toFixed(4)}%{/}  ${route.padEnd(22)} ${status}`);
  }

  // Open orders
  const orderLines: string[] = ['{bold} Open Orders{/bold}'];
  if (openOrders.length === 0) {
    orderLines.push(' {gray-fg}None{/gray-fg}');
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
    tradeLines.push(' {gray-fg}No trades in last 24h{/gray-fg}');
  } else {
    for (const t of recentTrades.slice(0, 8)) {
      const color = t.type === 'buy' ? '{green-fg}' : '{red-fg}';
      tradeLines.push(` ${color}${t.type.toUpperCase().padEnd(4)}{/} ${t.pair.padEnd(10)} ${parseFloat(t.vol).toFixed(6)} @ $${parseFloat(t.price).toFixed(2)}  fee=$${parseFloat(t.fee).toFixed(4)}  ${timeSince(t.time)}`);
    }
  }

  // Strategy status
  const sigLines: string[] = ['{bold} Strategy Status{/bold}'];
  if (!ts) {
    sigLines.push(' {gray-fg}Waiting for daemon...{/gray-fg}');
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
      sigLines.push(` {gray-fg}No open position — scanning for entry...{/gray-fg}`);
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
  const krakenNameMap: Record<string, string> = { ZUSD: 'USD', XXBT: 'BTC', XETH: 'ETH', XXDG: 'DOGE' };
  const priceOf: Record<string, number> = {};
  for (const p of prices) {
    if (p.exchange === 'kraken' && p.bid > 0) priceOf[p.pair.split('-')[0]] = p.bid;
  }

  // Kraken: sum cash + value crypto
  let krakenCash = 0;
  const krakenCrypto: { asset: string; amount: number; value: number }[] = [];
  for (const [k, v] of Object.entries(krakenBal)) {
    const name = krakenNameMap[k] ?? k;
    const val = parseFloat(v);
    if (val < 0.0001) continue;
    if (['USD', 'USDC', 'USDT'].includes(name)) { krakenCash += val; }
    else {
      const usdVal = val * (priceOf[name] ?? 0);
      if (usdVal > 0.01) krakenCrypto.push({ asset: name, amount: val, value: usdVal });
    }
  }

  // Binance: sum stablecoins
  let binanceCash = 0;
  const binanceCrypto: { asset: string; amount: number; value: number }[] = [];
  for (const [k, v] of Object.entries(binanceBal)) {
    const val = parseFloat(v);
    if (val < 0.0001) continue;
    if (['USD', 'USDC', 'USDT'].includes(k)) { binanceCash += val; }
    else {
      const usdVal = val * (priceOf[k] ?? 0);
      if (usdVal > 0.01) binanceCrypto.push({ asset: k, amount: val, value: usdVal });
    }
  }

  // Coinbase
  let coinbaseCash = 0;
  const coinbaseCrypto: { asset: string; amount: number; value: number }[] = [];
  for (const [k, v] of Object.entries(coinbaseBal)) {
    const val = parseFloat(v);
    if (val < 0.0001) continue;
    if (['USD', 'USDC', 'USDT'].includes(k)) { coinbaseCash += val; }
    else {
      const usdVal = val * (priceOf[k] ?? 0);
      if (usdVal > 0.01) coinbaseCrypto.push({ asset: k, amount: val, value: usdVal });
    }
  }

  const krakenTotal = krakenCash + krakenCrypto.reduce((s, c) => s + c.value, 0);
  const binanceTotal = binanceCash + binanceCrypto.reduce((s, c) => s + c.value, 0);
  const coinbaseTotal = coinbaseCash + coinbaseCrypto.reduce((s, c) => s + c.value, 0);
  const totalValue = krakenTotal + binanceTotal + coinbaseTotal;

  const balLines: string[] = [];
  // Kraken
  let krakenStr = ` {cyan-fg}Kraken{/}    $${krakenCash.toFixed(2)} USD`;
  for (const c of krakenCrypto) krakenStr += ` + ${c.amount.toFixed(4)} ${c.asset} ($${c.value.toFixed(2)})`;
  balLines.push(krakenStr);
  // Binance
  let binanceStr = ` {yellow-fg}Binance{/}   $${binanceCash.toFixed(2)} USDC`;
  for (const c of binanceCrypto) binanceStr += ` + ${c.amount.toFixed(4)} ${c.asset} ($${c.value.toFixed(2)})`;
  balLines.push(binanceStr);
  // Coinbase
  let coinbaseStr = ` {magenta-fg}Coinbase{/}  $${coinbaseCash.toFixed(2)} USD`;
  for (const c of coinbaseCrypto) coinbaseStr += ` + ${c.amount.toFixed(4)} ${c.asset} ($${c.value.toFixed(2)})`;
  balLines.push(coinbaseStr);
  // Total
  balLines.push(' ─────────────────────────');
  balLines.push(` {bold}Total:    $${totalValue.toFixed(2)}{/bold}`);

  // Activity log — daemon activity from API + local events
  const daemonLog = tradeState?.activityLog ?? [];
  const allLogs = [
    ...daemonLog.map((l) => ({ time: new Date(l.at).toLocaleTimeString('en-US', { hour12: false }), text: l.text })),
    ...logs,
  ].sort((a, b) => a.time.localeCompare(b.time)).slice(-50);
  const logLines = allLogs.map((l) => {
    let color = '{gray-fg}';
    if (l.text.includes('BUY')) color = '{green-fg}';
    else if (l.text.includes('SELL')) color = '{red-fg}';
    else if (l.text.includes('SIGNAL') || l.text.includes('⚡')) color = '{yellow-fg}';
    else if (l.text.includes('EXECUTED') || l.text.includes('✓')) color = '{green-fg}';
    else if (l.text.includes('SKIPPED') || l.text.includes('✗')) color = '{red-fg}';
    return `{gray-fg}${l.time}{/} ${color}${l.text}{/}`;
  });

  const row1H = DISPLAY_PAIRS.length + (daemonOnline ? 3 : 5) + (apiError ? 1 : 0);
  const row2H = Math.max(displaySpreads.length + 3, 5);
  const row3H = Math.max(trades.length + 2, balLines.length + 2, 8);

  return (
    <>
      <box top={0} left={0} width="100%" height={1} tags={true}
        style={{ bg: 'blue', fg: 'white' }} content={statusText} />

      <box label=" Prices (via API) " top={1} left={0} width="100%" height={row1H}
        border={{ type: 'line' }} tags={true} style={{ border: { fg: 'cyan' } }}
        content={priceLines.join('\n')} />

      <box label=" Arb Spreads " top={1 + row1H} left={0} width="40%" height={row2H}
        border={{ type: 'line' }} tags={true} style={{ border: { fg: 'yellow' } }}
        content={arbLines.join('\n')} />

      <box label=" Open Orders " top={1 + row1H} left="40%" width="30%" height={row2H}
        border={{ type: 'line' }} tags={true} scrollable={true}
        style={{ border: { fg: 'magenta' } }}
        content={orderLines.join('\n')} />

      <box label=" Trade Signals " top={1 + row1H} left="70%" width="30%" height={row2H}
        border={{ type: 'line' }} tags={true} scrollable={true}
        style={{ border: { fg: 'cyan' } }}
        content={sigLines.join('\n')} />

      <box label=" Recent Trades " top={1 + row1H + row2H} left={0} width="55%" height={row3H}
        border={{ type: 'line' }} tags={true} scrollable={true} mouse={true}
        style={{ border: { fg: 'green' } }}
        content={tradeLines.join('\n')} />

      <box label=" Balances " top={1 + row1H + row2H} left="55%" width="45%" height={row3H}
        border={{ type: 'line' }} tags={true} scrollable={true} mouse={true}
        style={{ border: { fg: 'green' } }}
        content={balLines.join('\n')} />

      <box label=" Activity Log " top={1 + row1H + row2H + row3H} left={0} width="100%"
        height={`100%-${2 + row1H + row2H + row3H}`}
        border={{ type: 'line' }} tags={true} scrollable={true} mouse={true}
        style={{ border: { fg: 'gray' } }}
        content={logLines.join('\n') || ' Waiting for daemon data...'} />
    </>
  );
}
