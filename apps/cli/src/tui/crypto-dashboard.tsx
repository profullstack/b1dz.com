import React, { useState, useEffect } from 'react';
import {
  KrakenFeed, BinanceUsFeed,
  getBalance, getBinanceBalance,
  getTradeHistory, getOpenOrders,
  type TradeEntry, type OpenOrder,
} from '@b1dz/source-crypto-arb';
import type { MarketSnapshot } from '@b1dz/core';
import { tuiEvents } from './index.js';

const PAIRS = ['BTC-USD', 'ETH-USD', 'SOL-USD'];
const FEEDS = [new KrakenFeed(), new BinanceUsFeed()];

interface PriceRow {
  exchange: string;
  pair: string;
  bid: number;
  ask: number;
}

interface ArbSpread {
  pair: string;
  spread: number;
  buyExchange: string;
  sellExchange: string;
  profitable: boolean;
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
  const [prices, setPrices] = useState<PriceRow[]>([]);
  const [spreads, setSpreads] = useState<ArbSpread[]>([]);
  const [krakenBal, setKrakenBal] = useState<Record<string, string>>({});
  const [binanceBal, setBinanceBal] = useState<Record<string, string>>({});
  const [trades, setTrades] = useState<TradeEntry[]>([]);
  const [openOrders, setOpenOrders] = useState<Record<string, OpenOrder>>({});
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [autoTrade, setAutoTrade] = useState(false);
  const [tickCount, setTickCount] = useState(0);

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

  // Poll prices + compute arb
  useEffect(() => {
    let active = true;
    const poll = async () => {
      const rows: PriceRow[] = [];
      const snapsByPair = new Map<string, MarketSnapshot[]>();

      for (const pair of PAIRS) {
        const snaps = (await Promise.all(FEEDS.map((f) => f.snapshot(pair))))
          .filter((s): s is MarketSnapshot => s != null);
        snapsByPair.set(pair, snaps);
        for (const s of snaps) {
          rows.push({ exchange: s.exchange, pair: s.pair, bid: s.bid, ask: s.ask });
        }
      }

      if (!active) return;
      setPrices(rows);
      setTickCount((c) => c + 1);

      const newSpreads: ArbSpread[] = [];
      for (const pair of PAIRS) {
        const snaps = snapsByPair.get(pair) ?? [];
        let bestSpread = -Infinity;
        let buyEx = '';
        let sellEx = '';
        for (const buyer of snaps) {
          for (const seller of snaps) {
            if (buyer.exchange === seller.exchange) continue;
            const gross = ((seller.bid - buyer.ask) / buyer.ask) * 100;
            if (gross > bestSpread) {
              bestSpread = gross;
              buyEx = buyer.exchange;
              sellEx = seller.exchange;
            }
          }
        }
        newSpreads.push({
          pair,
          spread: bestSpread === -Infinity ? 0 : bestSpread,
          buyExchange: buyEx,
          sellExchange: sellEx,
          profitable: bestSpread > 0.36,
        });
      }
      setSpreads(newSpreads);
    };

    poll();
    const timer = setInterval(poll, 2000);
    return () => { active = false; clearInterval(timer); };
  }, []);

  // Poll balances + trades + open orders every 10s
  useEffect(() => {
    let active = true;
    const poll = async () => {
      try {
        const [kb, bb, th, oo] = await Promise.all([
          getBalance(),
          getBinanceBalance(),
          getTradeHistory(),
          getOpenOrders(),
        ]);
        if (!active) return;
        setKrakenBal(kb);
        setBinanceBal(bb);

        // Sort trades by time descending, take last 10
        const tradeList = Object.values(th)
          .sort((a, b) => b.time - a.time)
          .slice(0, 10);
        setTrades(tradeList);
        setOpenOrders(oo);

        // Log new trades
        if (tradeList.length > 0) {
          const latest = tradeList[0];
          const age = Date.now() / 1000 - latest.time;
          if (age < 15) {
            const color = latest.type === 'buy' ? '{green-fg}' : '{red-fg}';
            addLog(`${color}${latest.type.toUpperCase()}{/} ${latest.pair} ${latest.vol} @ $${parseFloat(latest.price).toFixed(2)} fee=$${parseFloat(latest.fee).toFixed(4)}`);
          }
        }
      } catch (e) {
        addLog(`{red-fg}API error: ${(e as Error).message}{/}`);
      }
    };
    poll();
    const timer = setInterval(poll, 10000);
    return () => { active = false; clearInterval(timer); };
  }, []);

  // ── Render data ──

  const btc = prices.find((p) => p.pair === 'BTC-USD' && p.exchange === 'kraken')?.bid;
  const eth = prices.find((p) => p.pair === 'ETH-USD' && p.exchange === 'kraken')?.bid;

  // P/L calculation from recent trades
  let totalPnl = 0;
  let totalFees = 0;
  for (const t of trades) {
    totalFees += parseFloat(t.fee);
    const cost = parseFloat(t.cost);
    if (t.type === 'sell') totalPnl += cost;
    else totalPnl -= cost;
  }

  const statusText = ` b1dz crypto  BTC:$${btc?.toFixed(0) ?? '---'} ETH:$${eth?.toFixed(0) ?? '---'}  P/L:${totalPnl >= 0 ? '{green-fg}' : '{red-fg}'}$${totalPnl.toFixed(2)}{/}  fees:$${totalFees.toFixed(2)}  tick:${tickCount}  [t]rade [q]uit`;

  // Price table
  const priceLines: string[] = ['{bold} Pair       Kraken Bid      Binance Bid    Kraken Ask     Binance Ask{/bold}'];
  for (const pair of PAIRS) {
    const kr = prices.find((p) => p.pair === pair && p.exchange === 'kraken');
    const bn = prices.find((p) => p.pair === pair && p.exchange === 'binance-us');
    priceLines.push(
      ` ${pair.padEnd(10)} $${(kr?.bid ?? 0).toFixed(2).padStart(10)}  $${(bn?.bid ?? 0).toFixed(2).padStart(10)}  $${(kr?.ask ?? 0).toFixed(2).padStart(10)}  $${(bn?.ask ?? 0).toFixed(2).padStart(10)}`
    );
  }

  // Arb spread table
  const arbLines: string[] = ['{bold} Pair       Spread    Route                 Status{/bold}'];
  for (const s of spreads) {
    const color = s.profitable ? '{green-fg}' : '{white-fg}';
    const status = s.profitable ? '{green-fg}✓ PROFIT{/green-fg}' : '{gray-fg}below fees{/gray-fg}';
    const route = s.buyExchange ? `${s.buyExchange}→${s.sellExchange}` : '---';
    arbLines.push(` ${s.pair.padEnd(10)} ${color}${s.spread.toFixed(4)}%{/}  ${route.padEnd(22)} ${status}`);
  }

  // Open orders
  const orderEntries = Object.entries(openOrders);
  const orderLines: string[] = ['{bold} Open Orders{/bold}'];
  if (orderEntries.length === 0) {
    orderLines.push(' {gray-fg}No open orders{/gray-fg}');
  } else {
    for (const [id, o] of orderEntries.slice(0, 5)) {
      const filled = `${parseFloat(o.vol_exec).toFixed(6)}/${parseFloat(o.vol).toFixed(6)}`;
      orderLines.push(` ${o.descr.type.toUpperCase()} ${o.descr.pair} @ $${o.descr.price}  ${filled}  ${o.status}`);
    }
  }

  // Recent trades
  const tradeLines: string[] = ['{bold} Recent Trades (Kraken){/bold}'];
  if (trades.length === 0) {
    tradeLines.push(' {gray-fg}No recent trades{/gray-fg}');
  } else {
    for (const t of trades.slice(0, 8)) {
      const color = t.type === 'buy' ? '{green-fg}' : '{red-fg}';
      const pnlStr = t.type === 'sell' ? ` cost=$${parseFloat(t.cost).toFixed(2)}` : ` cost=$${parseFloat(t.cost).toFixed(2)}`;
      tradeLines.push(` ${color}${t.type.toUpperCase().padEnd(4)}{/} ${t.pair.padEnd(10)} ${parseFloat(t.vol).toFixed(6)} @ $${parseFloat(t.price).toFixed(2)}  fee=$${parseFloat(t.fee).toFixed(4)}  ${timeSince(t.time)}`);
    }
  }

  // Balances
  const krakenNameMap: Record<string, string> = { ZUSD: 'USD', XXBT: 'BTC', XETH: 'ETH', XXDG: 'DOGE' };
  const normKraken: Record<string, number> = {};
  for (const [k, v] of Object.entries(krakenBal)) {
    const name = krakenNameMap[k] ?? k;
    const val = parseFloat(v);
    if (val > 0.000000001) normKraken[name] = val;
  }
  const normBinance: Record<string, number> = {};
  for (const [k, v] of Object.entries(binanceBal)) {
    const val = parseFloat(v);
    if (val > 0.000000001) normBinance[k] = val;
  }
  const allAssets = [...new Set([...Object.keys(normKraken), ...Object.keys(normBinance)])].sort();

  const balLines: string[] = ['{bold} Asset      Kraken          Binance{/bold}'];
  let totalCash = 0;
  for (const asset of allAssets) {
    const kVal = normKraken[asset] ?? 0;
    const bVal = normBinance[asset] ?? 0;
    const isCash = ['USD', 'USDC', 'USDT'].includes(asset);
    const kStr = kVal > 0 ? (isCash ? `$${kVal.toFixed(2)}` : kVal.toFixed(8)) : '-';
    const bStr = bVal > 0 ? (isCash ? `$${bVal.toFixed(2)}` : bVal.toFixed(8)) : '-';
    balLines.push(` ${asset.padEnd(10)} ${kStr.padStart(14)}  ${bStr.padStart(14)}`);
    if (isCash) totalCash += kVal + bVal;
  }
  balLines.push(`{bold} Total cash: $${totalCash.toFixed(2)}{/bold}`);

  // Log
  const logLines = logs.map((l) => `{gray-fg}${l.time}{/gray-fg} ${l.text}`);

  // Layout rows
  const row1H = PAIRS.length + 3;  // prices
  const row2H = Math.max(PAIRS.length + 3, 5);  // arb + orders
  const row3H = Math.max(trades.length + 2, allAssets.length + 3, 5);  // trades + balances

  return (
    <>
      {/* Status bar */}
      <box top={0} left={0} width="100%" height={1} tags={true}
        style={{ bg: 'blue', fg: 'white' }} content={statusText} />

      {/* Row 1: Prices */}
      <box label=" Kraken + Binance.US " top={1} left={0} width="100%" height={row1H}
        border={{ type: 'line' }} tags={true} style={{ border: { fg: 'cyan' } }}
        content={priceLines.join('\n')} />

      {/* Row 2: Arb + Open Orders */}
      <box label=" Arb Spreads " top={1 + row1H} left={0} width="55%" height={row2H}
        border={{ type: 'line' }} tags={true} style={{ border: { fg: 'yellow' } }}
        content={arbLines.join('\n')} />

      <box label=" Open Orders " top={1 + row1H} left="55%" width="45%" height={row2H}
        border={{ type: 'line' }} tags={true} scrollable={true} mouse={true}
        style={{ border: { fg: 'magenta' } }}
        content={orderLines.join('\n')} />

      {/* Row 3: Recent Trades + Balances */}
      <box label=" Recent Trades " top={1 + row1H + row2H} left={0} width="60%" height={row3H}
        border={{ type: 'line' }} tags={true} scrollable={true} mouse={true}
        style={{ border: { fg: 'green' } }}
        content={tradeLines.join('\n')} />

      <box label=" Balances " top={1 + row1H + row2H} left="60%" width="40%" height={row3H}
        border={{ type: 'line' }} tags={true} scrollable={true} mouse={true}
        style={{ border: { fg: 'green' } }}
        content={balLines.join('\n')} />

      {/* Row 4: Log */}
      <box label=" Activity Log " top={1 + row1H + row2H + row3H} left={0} width="100%"
        height={`100%-${2 + row1H + row2H + row3H}`}
        border={{ type: 'line' }} tags={true} scrollable={true} mouse={true}
        style={{ border: { fg: 'gray' } }}
        content={logLines.join('\n') || ' Waiting for events...'} />
    </>
  );
}
