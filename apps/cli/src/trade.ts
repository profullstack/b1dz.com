/**
 * `b1dz trade`: buy and sell through your own broker (Alpaca, moomoo, ...).
 *
 *   b1dz trade                          broker, buying power, positions, open orders
 *   b1dz trade buy AAPL 5               market order for 5 shares
 *   b1dz trade buy AAPL $500            market order for $500 (brokers with fractional shares)
 *   b1dz trade sell AAPL 5 --limit 190.50 [--gtc] [--ext]
 *   b1dz trade orders                   open and recent orders
 *   b1dz trade cancel <order-id>
 *   b1dz trade watch [+NVDA -TSLA]      your account watchlist (the one /terminal shows)
 *
 *   --broker <id>   use this linked broker instead of your default
 *   --yes           do not ask before sending
 *   --json          print the API answer as JSON
 *
 * The same API the web terminal uses (/api/terminal/*). Your broker keys stay
 * sealed on b1dz.com; orders need an unlocked trading session (`b1dz unlock`).
 */
import { createInterface } from 'node:readline/promises';
import { describeOrder, editWatchlist, parseManualOrder, type BrokerOrderArgs } from '@b1dz/core';
import { loadCredentials } from './auth.js';

export const TRADE_USAGE = `b1dz trade: buy and sell through your own broker

  b1dz trade                          broker, buying power, positions, open orders
  b1dz trade buy <SYMBOL> <shares>    market order, e.g. b1dz trade buy AAPL 5
  b1dz trade buy <SYMBOL> $<dollars>  dollar order, e.g. b1dz trade buy SPY $500
  b1dz trade sell <SYMBOL> <shares> --limit <price> [--gtc] [--ext]
  b1dz trade orders                   open and recent orders
  b1dz trade cancel <order-id>
  b1dz trade watch [+SYM -SYM ...]    show or edit your account watchlist

  --broker <id>   alpaca, moomoo, ... (default: the one chosen in the terminal)
  --yes           send without asking
  --json          print JSON

Link a broker at b1dz.com/settings (Plugins), then run \`b1dz unlock\`.
Orders go to your own account. Nothing here is investment advice.`;

export type TradeCommand =
  | { kind: 'account' | 'orders' | 'help' }
  | { kind: 'order'; order: BrokerOrderArgs }
  | { kind: 'cancel'; orderId: string }
  | { kind: 'watch'; edits: { action: 'add' | 'remove'; symbol: string }[] }
  | { kind: 'error'; message: string };

export interface TradeFlags {
  broker?: string;
  yes: boolean;
  json: boolean;
}

/** Split flags from positionals. `--limit` and `--broker` take a value. */
export function parseTradeArgs(args: string[]): { command: TradeCommand; flags: TradeFlags } {
  const flags: TradeFlags = { yes: false, json: false };
  const pos: string[] = [];
  let limit: string | undefined;
  let gtc = false;
  let ext = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--yes' || a === '-y') flags.yes = true;
    else if (a === '--json') flags.json = true;
    else if (a === '--gtc') gtc = true;
    else if (a === '--ext') ext = true;
    else if (a === '--broker') flags.broker = (args[++i] ?? '').toLowerCase();
    else if (a === '--limit') limit = args[++i];
    else if (a === '--prod' || a === '--dev') continue;
    else pos.push(a);
  }
  const [cmd, ...rest] = pos;
  const done = (command: TradeCommand) => ({ command, flags });

  if (!cmd || cmd === 'account' || cmd === 'positions') return done({ kind: 'account' });
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') return done({ kind: 'help' });
  if (cmd === 'orders') return done({ kind: 'orders' });
  if (cmd === 'cancel') return rest[0] ? done({ kind: 'cancel', orderId: rest[0] }) : done({ kind: 'error', message: 'usage: b1dz trade cancel <order-id>' });
  if (cmd === 'watch' || cmd === 'watchlist') {
    const edits: { action: 'add' | 'remove'; symbol: string }[] = [];
    for (const tok of rest) {
      if (tok.startsWith('-') && tok.length > 1) edits.push({ action: 'remove', symbol: tok.slice(1) });
      else edits.push({ action: 'add', symbol: tok.replace(/^\+/, '') });
    }
    return done({ kind: 'watch', edits });
  }
  if (cmd === 'buy' || cmd === 'sell') {
    const [symbol, size] = rest;
    if (!symbol || !size) return done({ kind: 'error', message: `usage: b1dz trade ${cmd} <SYMBOL> <shares | $dollars> [--limit <price>] [--gtc] [--ext]` });
    const dollars = size.startsWith('$');
    const parsed = parseManualOrder({
      symbol,
      side: cmd,
      type: limit !== undefined ? 'limit' : 'market',
      tif: gtc ? 'gtc' : 'day',
      ...(dollars ? { notionalUsd: size.slice(1).replace(/,/g, '') } : { qty: size.replace(/,/g, '') }),
      ...(limit !== undefined ? { limitPrice: limit } : {}),
      ...(ext ? { extendedHours: true } : {}),
    });
    return done(parsed.ok ? { kind: 'order', order: parsed.order } : { kind: 'error', message: parsed.error });
  }
  return done({ kind: 'error', message: `unknown trade command: ${cmd}` });
}

/**
 * One order typed on a line, as the TUI ticket takes it:
 *   5            market order for 5 shares
 *   $500         market order for $500
 *   5 @190.50    limit order        (add gtc and/or ext after it)
 */
export function parseTicketLine(side: 'buy' | 'sell', symbol: string, line: string): ReturnType<typeof parseManualOrder> {
  const toks = line.trim().split(/\s+/).filter(Boolean);
  const size = toks.find((t) => !t.startsWith('@') && !/^(gtc|ext|day)$/i.test(t)) ?? '';
  const limit = toks.find((t) => t.startsWith('@'))?.slice(1);
  const has = (w: string) => toks.some((t) => t.toLowerCase() === w);
  return parseManualOrder({
    symbol,
    side,
    type: limit !== undefined ? 'limit' : 'market',
    tif: has('gtc') ? 'gtc' : 'day',
    ...(size.startsWith('$') ? { notionalUsd: size.slice(1).replace(/,/g, '') } : { qty: size.replace(/,/g, '') }),
    ...(limit !== undefined ? { limitPrice: limit } : {}),
    ...(has('ext') ? { extendedHours: true } : {}),
  });
}

function base(): string {
  return (process.env.B1DZ_API_URL || 'https://b1dz.com').replace(/\/$/, '');
}

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
export interface ApiAnswer {
  ok: boolean;
  status: number;
  body: Json;
}

/** The account API the web terminal uses, for the CLI and the TUI. Never exits the process. */
export interface TradeClient {
  signedIn(): boolean;
  account(broker?: string): Promise<ApiAnswer>;
  place(order: BrokerOrderArgs, broker?: string): Promise<ApiAnswer>;
  confirm(confirmId: string, broker?: string): Promise<ApiAnswer>;
  cancel(orderId: string, broker?: string): Promise<ApiAnswer>;
  watchlist(): Promise<ApiAnswer>;
  saveWatchlist(symbols: string[]): Promise<ApiAnswer>;
}

async function request(path: string, init: RequestInit = {}): Promise<ApiAnswer> {
  const c = loadCredentials();
  if (!c) return { ok: false, status: 401, body: { error: 'not signed in: run `b1dz login` first' } };
  try {
    const res = await fetch(`${base()}${path}`, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${c.accessToken}` } });
    const body = (await res.json().catch(() => ({}))) as Json;
    if (res.status === 401) return { ok: false, status: 401, body: { error: 'session expired: run `b1dz login` again' } };
    return { ok: res.ok, status: res.status, body };
  } catch (e) {
    return { ok: false, status: 0, body: { error: (e as Error).message || 'network error' } };
  }
}

export function tradeClient(): TradeClient {
  const q = (broker?: string) => (broker ? `?broker=${encodeURIComponent(broker)}` : '');
  const post = (path: string, body: unknown) => request(path, { method: 'POST', body: JSON.stringify(body) });
  return {
    signedIn: () => loadCredentials() !== null,
    account: (broker) => request(`/api/terminal/broker${q(broker)}`),
    place: (order, broker) => post('/api/terminal/orders', { ...order, ...(broker ? { broker } : {}) }),
    confirm: (confirmId, broker) => post('/api/terminal/orders/confirm', { confirmId, ...(broker ? { broker } : {}) }),
    cancel: (orderId, broker) => post('/api/terminal/orders/cancel', { orderId, ...(broker ? { broker } : {}) }),
    watchlist: () => request('/api/terminal/watchlist'),
    saveWatchlist: (symbols) => request('/api/terminal/watchlist', { method: 'PUT', body: JSON.stringify({ symbols }) }),
  };
}

/** What went wrong, in words for the user (a locked session gets the fix). */
export function tradeError(r: ApiAnswer): string {
  if (r.status === 423) return 'trading is locked: run `b1dz unlock`, then try again';
  return r.body.error ?? r.body.result?.message ?? `request failed (${r.status})`;
}

/** The account as plain lines: broker, buying power, positions, open orders. */
export function accountLines(a: Json): string[] {
  if (!a.brokers?.length) return ['No broker linked. Add Alpaca or moomoo at b1dz.com/settings (Plugins).'];
  if (a.error) return [`${a.label ?? a.broker}: ${a.error}`];
  const out = [`${a.label}  ${a.paper ? 'PAPER' : 'LIVE'}${a.session ? `  market ${a.session}` : ''}`, `Buying power  ${money(a.buyingPowerUsd)}`];
  if (a.brokers.length > 1) out.push(`Linked        ${a.brokers.map((b: Json) => `${b.id}${b.paper ? ' (paper)' : ''}`).join(', ')}`);
  out.push('', 'Positions');
  if (!a.positions?.length) out.push('  none');
  for (const p of a.positions ?? []) out.push(`  ${String(p.symbol).padEnd(7)} ${String(p.qty).padStart(10)}  avg ${p.avgEntry}  ${p.marketValue ? money(p.marketValue) : ''}`);
  if (a.ordersSupported) {
    out.push('', 'Open orders');
    const open = (a.orders ?? []).filter((o: Json) => o.open);
    if (!open.length) out.push('  none');
    for (const o of open) out.push(`  ${orderLine(o)}`);
  }
  return out;
}

function orderLine(o: Json): string {
  const px = o.type === 'limit' && o.limitPrice ? `limit ${o.limitPrice}` : o.type;
  return `${String(o.side).padEnd(4)} ${String(o.qty || '').padStart(8)} ${String(o.symbol).padEnd(7)} ${String(px).padEnd(14)} ${String(o.status).padEnd(9)} ${o.fillPrice ? `filled ${o.fillPrice}  ` : ''}${o.orderId}`;
}

async function call(path: string, init: RequestInit = {}): Promise<ApiAnswer> {
  const r = await request(path, init);
  if (r.status === 401) {
    console.error(r.body.error);
    process.exit(1);
  }
  return r;
}

const money = (v: unknown) => (typeof v === 'number' ? `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '');

function fail(r: ApiAnswer): never {
  console.error(`✗ ${tradeError(r)}`);
  process.exit(1);
}

function printOrders(orders: Json[], openOnly = false) {
  const shown = openOnly ? orders.filter((o) => o.open) : orders;
  if (!shown.length) return console.log(openOnly ? '  no open orders' : '  no orders');
  for (const o of shown) console.log(`  ${orderLine(o)}`);
}

async function account(flags: TradeFlags, ordersOnly: boolean) {
  const r = await call(`/api/terminal/broker${flags.broker ? `?broker=${encodeURIComponent(flags.broker)}` : ''}`);
  if (!r.ok) fail(r);
  if (flags.json) return console.log(JSON.stringify(r.body, null, 2));
  const a = r.body;
  if (!a.brokers?.length) return console.log('No broker linked. Add Alpaca or moomoo at b1dz.com/settings (Plugins).');
  if (a.error) {
    console.error(`✗ ${a.label ?? a.broker}: ${a.error}`);
    process.exit(1);
  }
  if (ordersOnly) {
    console.log(`${a.label} (${a.paper ? 'paper' : 'LIVE'}) orders`);
    return printOrders(a.orders ?? []);
  }
  console.log(accountLines(a).join('\n'));
}

async function order(o: BrokerOrderArgs, flags: TradeFlags) {
  const acct = await call(`/api/terminal/broker${flags.broker ? `?broker=${encodeURIComponent(flags.broker)}` : ''}`);
  if (!acct.ok) fail(acct);
  if (!acct.body.broker) {
    console.error('✗ no broker linked: add Alpaca or moomoo at b1dz.com/settings (Plugins)');
    process.exit(1);
  }
  const where = `${acct.body.label} ${acct.body.paper ? 'PAPER account' : 'LIVE account (real money)'}`;
  if (!flags.yes) {
    if (!process.stdin.isTTY) {
      console.error('✗ not a terminal: pass --yes to send without asking');
      process.exit(1);
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = (await rl.question(`${describeOrder(o)}\non ${where}. Send it? [y/N] `)).trim().toLowerCase();
    rl.close();
    if (answer !== 'y' && answer !== 'yes') return console.log('not sent');
  }
  let r = await call('/api/terminal/orders', { method: 'POST', body: JSON.stringify({ ...o, broker: acct.body.broker }) });
  const need = r.body.result?.needsConfirm;
  if (need) {
    // A broker warning is never answered by --yes: it is new information.
    console.log(`${acct.body.label} asks you to confirm: ${r.body.result.message}`);
    if (!process.stdin.isTTY) {
      console.error('✗ not sent: run this in a terminal to answer the broker');
      process.exit(1);
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = (await rl.question('Confirm and send? [y/N] ')).trim().toLowerCase();
    rl.close();
    if (answer !== 'y' && answer !== 'yes') return console.log('not sent');
    r = await call('/api/terminal/orders/confirm', { method: 'POST', body: JSON.stringify({ confirmId: need.id, broker: acct.body.broker }) });
  }
  if (flags.json) console.log(JSON.stringify(r.body, null, 2));
  if (!r.ok || !r.body.result?.ok) fail(r);
  if (!flags.json) console.log(`✓ ${describeOrder(o)}: ${r.body.result.status ?? 'sent'} (${r.body.result.orderId ?? 'no id'}) on ${where}`);
}

async function watch(edits: { action: 'add' | 'remove'; symbol: string }[], flags: TradeFlags) {
  const cur = await call('/api/terminal/watchlist');
  if (!cur.ok) fail(cur);
  let list: string[] = cur.body.symbols ?? [];
  if (edits.length) {
    for (const e of edits) list = editWatchlist(list, e.action, e.symbol);
    const saved = await call('/api/terminal/watchlist', { method: 'PUT', body: JSON.stringify({ symbols: list }) });
    if (!saved.ok) fail(saved);
    list = saved.body.symbols ?? list;
  }
  if (flags.json) console.log(JSON.stringify({ symbols: list }, null, 2));
  else console.log(list.length ? list.join(' ') : '(empty)');
}

export async function runTradeCli(args: string[]): Promise<number> {
  const { command, flags } = parseTradeArgs(args);
  switch (command.kind) {
    case 'help':
      console.log(TRADE_USAGE);
      return 0;
    case 'error':
      console.error(`${command.message}\n\n${TRADE_USAGE}`);
      return 2;
    case 'account':
      await account(flags, false);
      return 0;
    case 'orders':
      await account(flags, true);
      return 0;
    case 'cancel': {
      const r = await call('/api/terminal/orders/cancel', { method: 'POST', body: JSON.stringify({ orderId: command.orderId, ...(flags.broker ? { broker: flags.broker } : {}) }) });
      if (!r.ok) fail(r);
      console.log(flags.json ? JSON.stringify(r.body, null, 2) : `✓ order ${command.orderId} canceled`);
      return 0;
    }
    case 'watch':
      await watch(command.edits, flags);
      return 0;
    case 'order':
      await order(command.order, flags);
      return 0;
  }
}
