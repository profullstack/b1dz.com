/**
 * The research terminal's account features: a saved watchlist and manual
 * orders through the user's own broker (Alpaca, moomoo, ...).
 *
 *   GET  /api/terminal/watchlist                 { symbols, saved }
 *   PUT  /api/terminal/watchlist { symbols }     replace the list
 *   GET  /api/terminal/broker[?broker=id]        linked brokers, buying power, positions, orders
 *   PUT  /api/terminal/broker { broker }         remember which broker the ticket uses
 *   POST /api/terminal/orders { symbol, side, qty | notionalUsd, type, limitPrice?, tif?, extendedHours?, broker? }
 *   POST /api/terminal/orders/cancel  { orderId, broker? }
 *   POST /api/terminal/orders/confirm { confirmId, broker? }
 *
 * The watchlist lives in the user's plain settings (TERMINAL_WATCHLIST), apart
 * from EQUITY_WATCHLIST, which is the list the automated strategies trade.
 * Watching a ticker never makes the bot trade it.
 *
 * Orders need a real session (cookie or Supabase bearer): agent tokens are
 * not accepted here. The web process never sees a broker credential; it
 * relays the ticket to the daemon, which holds them only while the user's
 * trading session is unlocked.
 */
import type { NextRequest } from 'next/server';
import { DEFAULT_TERMINAL_WATCHLIST, editWatchlist, parseManualOrder, parseWatchlist, serializeWatchlist } from '@b1dz/core/terminal';
import { authenticate, type AuthedRequest } from '@/lib/api-auth';
import { requestOrigin } from '@/lib/credits';
import { daemonEquity, type EquityAction } from '@/lib/daemon-control';
import { loadSettingsRow, type Sb } from '@/lib/settings-row';

const NO_STORE = { 'cache-control': 'no-store' };

export function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

/**
 * A browser sends Origin on every cross-site request that can carry the
 * session cookie. Refuse one that is not ours; a bearer caller (CLI) has no
 * ambient credential to ride on and is let through.
 */
export function crossSite(req: NextRequest): boolean {
  if (req.headers.get('authorization')?.startsWith('Bearer ')) return false;
  const origin = req.headers.get('origin');
  if (!origin) return false;
  return origin.replace(/\/$/, '') !== requestOrigin(req);
}

export async function terminalUser(req: NextRequest): Promise<AuthedRequest | Response> {
  const auth = await authenticate(req);
  if (!auth) return json({ error: 'unauthorized: sign in to use the watchlist and trading' }, 401);
  if (req.method !== 'GET' && crossSite(req)) return json({ error: 'cross-site request refused' }, 403);
  return auth;
}

async function readBody(req: NextRequest): Promise<Record<string, unknown>> {
  const raw = (await req.json().catch(() => null)) as unknown;
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

/** Merge a few plain settings keys for a user (null removes a key). */
async function savePlain(who: { client: unknown; userId: string }, patch: Record<string, string | null>): Promise<void> {
  const row = await loadSettingsRow(who.client, who.userId);
  const merged: Record<string, unknown> = { ...(row?.payload_plain ?? {}) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete merged[k];
    else merged[k] = v;
  }
  const { error } = await (who.client as unknown as Sb)
    .from('user_settings')
    .upsert({ user_id: who.userId, payload_plain: merged, updated_at: new Date().toISOString() }, { onConflict: 'user_id' });
  if (error) throw new Error(error.message);
}

/** The user's watchlist, or the default list until they save one. Used by the routes and the MCP server. */
export async function readWatchlist(client: unknown, userId: string): Promise<{ symbols: string[]; saved: boolean }> {
  const stored = (await loadSettingsRow(client, userId))?.payload_plain?.TERMINAL_WATCHLIST;
  // A saved empty string is a deliberately emptied list, not "never saved".
  if (typeof stored === 'string') return { symbols: parseWatchlist(stored), saved: true };
  return { symbols: DEFAULT_TERMINAL_WATCHLIST, saved: false };
}

/** Add and remove tickers, then save. Returns the new list. */
export async function changeWatchlist(client: unknown, userId: string, add: unknown, remove: unknown): Promise<{ symbols: string[]; saved: boolean }> {
  let list = (await readWatchlist(client, userId)).symbols;
  for (const s of parseWatchlist(remove)) list = editWatchlist(list, 'remove', s);
  for (const s of parseWatchlist(add)) list = editWatchlist(list, 'add', s);
  await savePlain({ client, userId }, { TERMINAL_WATCHLIST: serializeWatchlist(list) });
  return { symbols: list, saved: true };
}

// ---- watchlist -------------------------------------------------------------

export async function getWatchlist(req: NextRequest): Promise<Response> {
  const auth = await terminalUser(req);
  if (auth instanceof Response) return auth;
  try {
    return json(await readWatchlist(auth.client, auth.userId));
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
}

export async function putWatchlist(req: NextRequest): Promise<Response> {
  const auth = await terminalUser(req);
  if (auth instanceof Response) return auth;
  const body = await readBody(req);
  if (!Array.isArray(body.symbols) && typeof body.symbols !== 'string') return json({ error: 'symbols must be a list of tickers' }, 400);
  const symbols = parseWatchlist(body.symbols);
  try {
    await savePlain(auth, { TERMINAL_WATCHLIST: serializeWatchlist(symbols) });
    return json({ symbols, saved: true });
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
}

// ---- broker and orders -----------------------------------------------------

const BROKER_ID = /^[a-z]{2,20}$/;

function brokerOf(v: unknown): string | undefined {
  return typeof v === 'string' && BROKER_ID.test(v.trim().toLowerCase()) ? v.trim().toLowerCase() : undefined;
}

async function relay(action: EquityAction, auth: AuthedRequest, body: Record<string, unknown>): Promise<Response> {
  const r = await daemonEquity(action, auth.userId, body);
  return json(r.body, r.status);
}

export async function getBroker(req: NextRequest): Promise<Response> {
  const auth = await terminalUser(req);
  if (auth instanceof Response) return auth;
  const broker = brokerOf(new URL(req.url).searchParams.get('broker'));
  return relay('account', auth, broker ? { broker } : {});
}

export async function putBroker(req: NextRequest): Promise<Response> {
  const auth = await terminalUser(req);
  if (auth instanceof Response) return auth;
  const broker = brokerOf((await readBody(req)).broker);
  if (!broker) return json({ error: 'broker required' }, 400);
  try {
    await savePlain(auth, { TERMINAL_BROKER: broker });
    return json({ broker });
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
}

export async function postOrder(req: NextRequest): Promise<Response> {
  const auth = await terminalUser(req);
  if (auth instanceof Response) return auth;
  const body = await readBody(req);
  // Same rules the daemon applies: fail a bad ticket here, before the relay.
  const parsed = parseManualOrder(body);
  if (!parsed.ok) return json({ error: parsed.error }, 400);
  const broker = brokerOf(body.broker);
  console.log(`[api] terminal order user=${auth.userId.slice(0, 8)} broker=${broker ?? 'default'} ${parsed.order.side} ${parsed.order.symbol}`);
  return relay('order', auth, { ...parsed.order, ...(broker ? { broker } : {}) });
}

export async function postCancel(req: NextRequest): Promise<Response> {
  const auth = await terminalUser(req);
  if (auth instanceof Response) return auth;
  const body = await readBody(req);
  const orderId = typeof body.orderId === 'string' ? body.orderId.trim() : '';
  if (!orderId || orderId.length > 128) return json({ error: 'orderId required' }, 400);
  const broker = brokerOf(body.broker);
  return relay('cancel', auth, { orderId, ...(broker ? { broker } : {}) });
}

export async function postConfirm(req: NextRequest): Promise<Response> {
  const auth = await terminalUser(req);
  if (auth instanceof Response) return auth;
  const body = await readBody(req);
  const confirmId = typeof body.confirmId === 'string' ? body.confirmId.trim() : '';
  if (!confirmId || confirmId.length > 256) return json({ error: 'confirmId required' }, 400);
  const broker = brokerOf(body.broker);
  return relay('confirm', auth, { confirmId, ...(broker ? { broker } : {}) });
}
