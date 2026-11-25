'use client';

/**
 * The terminal's right-hand panel: a saved watchlist, the linked broker
 * account, and the order ticket.
 *
 * The watchlist is the user's own list (saved to their account when signed
 * in, to this browser otherwise). It is separate from the list the automated
 * strategies trade: watching a ticker never makes the bot trade it.
 *
 * An order is always the user's explicit click: fill the ticket, review it,
 * place it. Paper and live accounts are labelled on every step. The browser
 * never holds a broker key; /api/terminal/orders relays the ticket to the
 * daemon, which needs the user's trading session unlocked.
 */
import Link from 'next/link';
import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from 'react';
import { DEFAULT_TERMINAL_WATCHLIST, describeOrder, editWatchlist, estimateOrderUsd, isOrderSymbol, normalizeWatchSymbol, parseManualOrder, parseWatchlist } from '@b1dz/core/terminal';
import { formatValue } from '@b1dz/research/format';
import { cardUrl, chunk, watchQuotes, type WatchQuote } from './logic';

const LS_WATCH = 'b1dz:terminal:watchlist';

export interface WatchPanelHandle {
  add(symbol: string): void;
  trade(symbol: string, side: 'buy' | 'sell'): void;
}

interface BrokerInfo {
  id: string;
  label: string;
  paper: boolean;
  fractional: boolean;
}
interface Position {
  symbol: string;
  qty: number;
  avgEntry: number;
  marketValue: number;
}
interface Order {
  orderId: string;
  symbol: string;
  side: 'buy' | 'sell';
  type: string;
  qty: number;
  filledQty: number;
  limitPrice?: number;
  fillPrice?: number;
  status: string;
  open: boolean;
}
interface Account {
  brokers: BrokerInfo[];
  broker?: string;
  label?: string;
  paper?: boolean;
  fractional?: boolean;
  maxOrderUsd?: number | null;
  buyingPowerUsd?: number;
  positions?: Position[];
  orders?: Order[];
  session?: string | null;
  ordersSupported?: boolean;
  error?: string;
  locked?: boolean;
}
interface OrderResult {
  ok: boolean;
  message: string;
  orderId?: string;
  status?: string;
  needsConfirm?: { id: string; url?: string };
}
interface Ticket {
  symbol: string;
  side: 'buy' | 'sell';
  sizeBy: 'shares' | 'usd';
  size: string;
  type: 'market' | 'limit';
  limit: string;
  tif: 'day' | 'gtc';
  ext: boolean;
  step: 'edit' | 'review' | 'sending' | 'done';
  liveAck: boolean;
  error?: string;
  result?: OrderResult;
}

const usd = (v: number | null | undefined) => (v == null ? '' : formatValue(v, 'usd', 2));
const tone = (v: number | null | undefined) => (!v ? 'text-zinc-400' : v > 0 ? 'text-emerald-400' : 'text-red-400');
const SESSION: Record<string, string> = { open: 'market open', pre: 'pre-market', post: 'after hours', closed: 'market closed' };

async function api<T>(url: string, init?: RequestInit): Promise<{ ok: boolean; status: number; body: T & { error?: string } }> {
  try {
    const res = await fetch(url, { credentials: 'same-origin', ...init, headers: { accept: 'application/json', ...(init?.body ? { 'content-type': 'application/json' } : {}) } });
    const body = (await res.json().catch(() => ({}))) as T & { error?: string };
    return { ok: res.ok, status: res.status, body };
  } catch (e) {
    return { ok: false, status: 0, body: { error: (e as Error).message || 'network error' } as T & { error?: string } };
  }
}

export function WatchPanel(props: {
  ref?: Ref<WatchPanelHandle>;
  open: boolean;
  signedIn: boolean;
  loginHref: string;
  onClose: () => void;
  onOpenSymbol: (symbol: string) => void;
  flash: (text: string) => void;
}) {
  const { open, signedIn, flash } = props;
  const [list, setList] = useState<string[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [quotes, setQuotes] = useState<Record<string, WatchQuote>>({});
  const [quoteNote, setQuoteNote] = useState('');
  const [draft, setDraft] = useState('');
  const [account, setAccount] = useState<Account | null>(null);
  const [accountBusy, setAccountBusy] = useState(false);
  const [brokerPick, setBrokerPick] = useState<string | undefined>(undefined);
  const [ticket, setTicket] = useState<Ticket | null>(null);
  const listRef = useRef<string[]>([]);
  listRef.current = list;

  // ---- watchlist: account when signed in, this browser otherwise ------------
  useEffect(() => {
    let dead = false;
    const local = () => {
      try {
        const raw = window.localStorage.getItem(LS_WATCH);
        return raw === null ? DEFAULT_TERMINAL_WATCHLIST : parseWatchlist(JSON.parse(raw));
      } catch {
        return DEFAULT_TERMINAL_WATCHLIST;
      }
    };
    if (!signedIn) {
      setList(local());
      setLoaded(true);
      return;
    }
    void api<{ symbols?: string[] }>('/api/terminal/watchlist').then((r) => {
      if (dead) return;
      setList(r.ok && Array.isArray(r.body.symbols) ? parseWatchlist(r.body.symbols) : local());
      setLoaded(true);
    });
    return () => {
      dead = true;
    };
  }, [signedIn]);

  const save = useCallback(
    (next: string[]) => {
      if (next === listRef.current) return;
      setList(next);
      try {
        window.localStorage.setItem(LS_WATCH, JSON.stringify(next));
      } catch {
        /* private mode: the list still works for this visit */
      }
      if (signedIn) {
        void api('/api/terminal/watchlist', { method: 'PUT', body: JSON.stringify({ symbols: next }) }).then((r) => {
          if (!r.ok) flash(`watchlist not saved: ${r.body.error ?? `HTTP ${r.status}`}`);
        });
      }
    },
    [signedIn, flash],
  );

  const add = useCallback(
    (input: string) => {
      let next = listRef.current;
      const added: string[] = [];
      for (const tok of input.split(/[\s,]+/)) {
        const s = normalizeWatchSymbol(tok);
        if (!s || next.includes(s)) continue;
        next = editWatchlist(next, 'add', s);
        added.push(s);
      }
      if (added.length) {
        save(next);
        flash(`watching ${added.join(', ')}`);
      } else if (input.trim()) flash(normalizeWatchSymbol(input) ? `${input.trim().toUpperCase()} is already on the list` : 'not a ticker');
    },
    [save, flash],
  );

  // ---- quotes: the Watchlist card, 40 symbols a call, refreshed each minute --
  const key = list.join(',');
  const loadQuotes = useCallback(async () => {
    const symbols = listRef.current;
    if (!signedIn || !symbols.length) return;
    const parts = await Promise.all(
      chunk(symbols, 40).map((part) => api<{ blocks?: { kind: string; rows?: Record<string, unknown>[] }[]; asOf?: string }>(cardUrl('overview.watchlist', { symbols: part.join(',') }))),
    );
    const next: Record<string, WatchQuote> = {};
    let failed = '';
    for (const p of parts) {
      if (p.ok) Object.assign(next, watchQuotes(p.body.blocks));
      else failed = p.body.error ?? `HTTP ${p.status}`;
    }
    setQuotes((cur) => ({ ...cur, ...next }));
    setQuoteNote(failed ? `quotes unavailable: ${failed}` : '');
  }, [signedIn]);
  useEffect(() => {
    if (!open || !loaded) return;
    void loadQuotes();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void loadQuotes();
    }, 60_000);
    return () => window.clearInterval(timer);
  }, [open, loaded, key, loadQuotes]);

  // ---- broker account -------------------------------------------------------
  const loadAccount = useCallback(
    async (broker?: string) => {
      if (!signedIn) return;
      setAccountBusy(true);
      const r = await api<Account>(`/api/terminal/broker${broker ? `?broker=${encodeURIComponent(broker)}` : ''}`);
      setAccountBusy(false);
      if (r.status === 423) setAccount({ brokers: [], locked: true, error: r.body.error });
      else if (r.ok || Array.isArray(r.body.brokers)) setAccount({ ...r.body, brokers: r.body.brokers ?? [] });
      else setAccount({ brokers: [], error: r.body.error ?? `HTTP ${r.status}` });
    },
    [signedIn],
  );
  useEffect(() => {
    if (!open || !signedIn) return;
    void loadAccount(brokerPick);
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void loadAccount(brokerPick);
    }, 60_000);
    return () => window.clearInterval(timer);
  }, [open, signedIn, brokerPick, loadAccount]);

  const pickBroker = (id: string) => {
    setBrokerPick(id);
    void api('/api/terminal/broker', { method: 'PUT', body: JSON.stringify({ broker: id }) });
  };

  // ---- ticket ---------------------------------------------------------------
  const openTicket = useCallback((symbol: string, side: 'buy' | 'sell', qty?: number) => {
    const s = symbol.trim().toUpperCase();
    setTicket({ symbol: s, side, sizeBy: 'shares', size: qty ? String(qty) : '', type: 'market', limit: '', tif: 'day', ext: false, step: 'edit', liveAck: false });
  }, []);

  useImperativeHandle(props.ref, () => ({ add, trade: openTicket }), [add, openTicket]);

  const live = account?.paper === false;
  const ready = !!account?.broker && !account.error;
  const held = useMemo(() => new Map((account?.positions ?? []).map((p) => [p.symbol.toUpperCase(), p.qty])), [account]);

  const ticketOrder = useMemo(() => {
    if (!ticket) return null;
    return parseManualOrder({
      symbol: ticket.symbol,
      side: ticket.side,
      type: ticket.type,
      tif: ticket.tif,
      ...(ticket.sizeBy === 'usd' ? { notionalUsd: ticket.size } : { qty: ticket.size }),
      ...(ticket.type === 'limit' ? { limitPrice: ticket.limit } : {}),
      ...(ticket.ext ? { extendedHours: true } : {}),
    });
  }, [ticket]);

  const review = () => {
    if (!ticket || !ticketOrder) return;
    if (!ticketOrder.ok) return setTicket({ ...ticket, error: ticketOrder.error });
    const o = ticketOrder.order;
    if (account?.fractional === false && o.qty != null && !Number.isInteger(o.qty)) return setTicket({ ...ticket, error: `${account.label} takes whole shares only` });
    if (o.side === 'sell' && o.qty != null && o.qty > (held.get(o.symbol) ?? 0)) {
      return setTicket({ ...ticket, error: `You hold ${held.get(o.symbol) ?? 0} ${o.symbol}. Short selling is not available here.` });
    }
    setTicket({ ...ticket, step: 'review', error: undefined });
  };

  const finish = (t: Ticket, r: { ok: boolean; status: number; body: { result?: OrderResult; error?: string; locked?: boolean } }) => {
    const result = r.body.result;
    if (result?.needsConfirm) return setTicket({ ...t, step: 'review', result, error: undefined });
    if (r.ok && result?.ok) {
      setTicket({ ...t, step: 'done', result, error: undefined });
      flash(`${t.side} ${t.symbol}: ${result.status ?? 'sent'}`);
    } else setTicket({ ...t, step: 'edit', result: undefined, error: r.body.error ?? result?.message ?? `HTTP ${r.status}` });
    void loadAccount(brokerPick);
  };

  const place = async () => {
    if (!ticket || !ticketOrder?.ok) return;
    const t: Ticket = { ...ticket, step: 'sending', error: undefined };
    setTicket(t);
    finish(t, await api('/api/terminal/orders', { method: 'POST', body: JSON.stringify({ ...ticketOrder.order, broker: account?.broker }) }));
  };

  const confirm = async () => {
    const id = ticket?.result?.needsConfirm?.id;
    if (!ticket || !id) return;
    const t: Ticket = { ...ticket, step: 'sending', error: undefined };
    setTicket(t);
    finish({ ...t, result: undefined }, await api('/api/terminal/orders/confirm', { method: 'POST', body: JSON.stringify({ confirmId: id, broker: account?.broker }) }));
  };

  const cancel = async (orderId: string) => {
    const r = await api('/api/terminal/orders/cancel', { method: 'POST', body: JSON.stringify({ orderId, broker: account?.broker }) });
    flash(r.ok ? 'order canceled' : `cancel failed: ${r.body.error ?? `HTTP ${r.status}`}`);
    void loadAccount(brokerPick);
  };

  if (!open) return null;

  const btn = 'rounded px-1.5 py-0.5 text-xs';
  const openOrders = (account?.orders ?? []).filter((o) => o.open);
  const doneOrders = (account?.orders ?? []).filter((o) => !o.open).slice(0, 6);
  const lastOf = (s: string) => quotes[s]?.last ?? null;
  const est = ticketOrder?.ok ? estimateOrderUsd(ticketOrder.order, lastOf(ticketOrder.order.symbol) ?? 0) : 0;

  return (
    <aside aria-label="Watchlist and trading" className="absolute inset-0 z-30 flex w-full shrink-0 flex-col overflow-y-auto border-l border-zinc-800 bg-zinc-950 md:static md:z-auto md:w-80">
      <div className="flex items-center gap-2 border-b border-zinc-800 px-3 py-1.5">
        <h2 className="font-semibold text-amber-300">Watchlist</h2>
        <span className="text-xs text-zinc-500">{list.length}</span>
        <button type="button" onClick={() => void loadQuotes()} className={`${btn} ml-auto text-zinc-500 hover:bg-zinc-800 hover:text-zinc-100`} title="Refresh quotes">
          refresh
        </button>
        <button type="button" onClick={props.onClose} className={`${btn} text-zinc-500 hover:bg-zinc-800 hover:text-zinc-100`} aria-label="Close the watchlist">
          close
        </button>
      </div>

      <form
        className="flex gap-1 border-b border-zinc-800 px-3 py-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          add(draft);
          setDraft('');
        }}
      >
        <label htmlFor="watch-add" className="sr-only">
          Add a ticker
        </label>
        <input
          id="watch-add"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="add ticker, e.g. NVDA"
          autoComplete="off"
          spellCheck={false}
          className="w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-0.5 text-zinc-100 placeholder:text-zinc-600 focus:border-amber-400 focus:outline-none"
        />
        <button type="submit" className={`${btn} border border-zinc-700 text-zinc-300 hover:text-white`}>
          add
        </button>
      </form>

      {!list.length && loaded && <p className="px-3 py-2 text-xs text-zinc-500">Nothing on the list yet. Add a ticker above, or press a on any company page.</p>}
      <table className="w-full border-collapse text-xs">
        <tbody>
          {list.map((s) => {
            const q = quotes[s];
            const can = signedIn && isOrderSymbol(s);
            return (
              <tr key={s} className="border-b border-zinc-900 hover:bg-zinc-900/60">
                <th scope="row" className="py-[3px] pl-3 pr-1 text-left font-normal">
                  <button type="button" onClick={() => props.onOpenSymbol(s)} className="text-cyan-300 hover:underline" title={`Open ${s}`}>
                    {s}
                  </button>
                </th>
                <td className="px-1 text-right tabular-nums text-zinc-200">{q?.last != null ? formatValue(q.last, 'num', 2) : ''}</td>
                <td className={`px-1 text-right tabular-nums ${tone(q?.day)}`}>{q?.day != null ? formatValue(q.day, 'signedPct', 2) : ''}</td>
                <td className="whitespace-nowrap py-[3px] pl-1 pr-2 text-right">
                  {can && (
                    <>
                      <button type="button" onClick={() => openTicket(s, 'buy')} className={`${btn} text-emerald-400 hover:bg-emerald-500/20`} title={`Buy ${s}`}>
                        buy
                      </button>
                      <button type="button" onClick={() => openTicket(s, 'sell', held.get(s))} className={`${btn} text-red-400 hover:bg-red-500/20`} title={`Sell ${s}`}>
                        sell
                      </button>
                    </>
                  )}
                  <button type="button" onClick={() => save(editWatchlist(listRef.current, 'remove', s))} className={`${btn} text-zinc-600 hover:bg-zinc-800 hover:text-zinc-200`} aria-label={`Remove ${s}`}>
                    ×
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {signedIn && list.length > 0 && <p className="px-3 py-1 text-[11px] text-zinc-600">{quoteNote || 'Last is the latest daily close, not a live quote.'}</p>}
      {!signedIn && (
        <p className="px-3 py-2 text-xs text-zinc-500">
          This list is saved in this browser.{' '}
          <Link href={props.loginHref} className="text-amber-300 underline">
            Sign in
          </Link>{' '}
          for prices, to keep it on your account, and to trade.
        </p>
      )}

      {signedIn && (
        <section className="mt-2 border-t border-zinc-800">
          <div className="flex items-center gap-2 px-3 py-1.5">
            <h2 className="font-semibold text-amber-300">Account</h2>
            {account?.broker && (
              <span className={`rounded px-1.5 text-[11px] font-semibold ${live ? 'bg-red-500 text-white' : 'bg-zinc-700 text-zinc-200'}`}>{live ? 'LIVE' : 'PAPER'}</span>
            )}
            <button type="button" onClick={() => void loadAccount(brokerPick)} className={`${btn} ml-auto text-zinc-500 hover:bg-zinc-800 hover:text-zinc-100`}>
              {accountBusy ? '…' : 'refresh'}
            </button>
          </div>
          <div className="space-y-2 px-3 pb-3 text-xs">
            {!account && <p className="animate-pulse text-zinc-500">loading…</p>}
            {account?.locked && (
              <p className="text-amber-200">
                Trading is locked.{' '}
                <Link href="/settings" className="underline">
                  Unlock it with your passphrase
                </Link>
                , then refresh.
              </p>
            )}
            {account && !account.locked && !account.brokers.length && !account.error && (
              <p className="text-zinc-400">
                No broker linked.{' '}
                <Link href="/settings?tab=plugins" className="text-amber-300 underline">
                  Add Alpaca or moomoo
                </Link>{' '}
                to buy and sell from here.
              </p>
            )}
            {account && account.brokers.length > 1 && (
              <label className="flex items-center gap-2 text-zinc-500">
                Broker
                <select value={account.broker ?? ''} onChange={(e) => pickBroker(e.target.value)} className="rounded border border-zinc-700 bg-zinc-900 px-1.5 py-0.5 text-zinc-100">
                  {account.brokers.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.label} ({b.paper ? 'paper' : 'live'})
                    </option>
                  ))}
                </select>
              </label>
            )}
            {account?.error && !account.locked && <p className="text-red-400">{account.label ? `${account.label}: ` : ''}{account.error}</p>}
            {ready && (
              <>
                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
                  <dt className="text-zinc-500">Broker</dt>
                  <dd className="text-right text-zinc-200">{account!.label}</dd>
                  <dt className="text-zinc-500">Buying power</dt>
                  <dd className="text-right tabular-nums text-zinc-200">{usd(account!.buyingPowerUsd)}</dd>
                  {account!.session && (
                    <>
                      <dt className="text-zinc-500">Session</dt>
                      <dd className="text-right text-zinc-200">{SESSION[account!.session] ?? account!.session}</dd>
                    </>
                  )}
                </dl>

                <div>
                  <div className="mb-0.5 font-semibold text-zinc-300">Positions</div>
                  {!account!.positions?.length && <p className="text-zinc-600">none</p>}
                  <table className="w-full border-collapse">
                    <tbody>
                      {(account!.positions ?? []).map((p) => (
                        <tr key={p.symbol} className="border-b border-zinc-900">
                          <th scope="row" className="py-[2px] text-left font-normal">
                            <button type="button" onClick={() => props.onOpenSymbol(p.symbol)} className="text-cyan-300 hover:underline">
                              {p.symbol}
                            </button>
                          </th>
                          <td className="px-1 text-right tabular-nums text-zinc-200">{formatValue(p.qty, 'num', Number.isInteger(p.qty) ? 0 : 4)}</td>
                          <td className="px-1 text-right tabular-nums text-zinc-400">{p.marketValue ? usd(p.marketValue) : `@ ${formatValue(p.avgEntry, 'num', 2)}`}</td>
                          <td className="text-right">
                            {p.qty > 0 && isOrderSymbol(p.symbol) && (
                              <button type="button" onClick={() => openTicket(p.symbol, 'sell', p.qty)} className={`${btn} text-red-400 hover:bg-red-500/20`}>
                                sell
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {account!.ordersSupported && (
                  <div>
                    <div className="mb-0.5 font-semibold text-zinc-300">Orders</div>
                    {!openOrders.length && !doneOrders.length && <p className="text-zinc-600">none</p>}
                    <ul className="space-y-0.5">
                      {[...openOrders, ...doneOrders].map((o) => (
                        <li key={o.orderId} className="flex items-baseline gap-1">
                          <span className={o.side === 'buy' ? 'text-emerald-400' : 'text-red-400'}>{o.side}</span>
                          <span className="tabular-nums text-zinc-200">
                            {o.qty || ''} {o.symbol}
                          </span>
                          <span className="truncate text-zinc-500">
                            {o.type === 'limit' && o.limitPrice ? `limit ${formatValue(o.limitPrice, 'num', 2)}` : o.type}
                            {o.fillPrice ? ` · filled ${formatValue(o.fillPrice, 'num', 2)}` : ''}
                          </span>
                          <span className={`ml-auto ${o.open ? 'text-amber-300' : 'text-zinc-500'}`}>{o.status}</span>
                          {o.open && (
                            <button type="button" onClick={() => void cancel(o.orderId)} className={`${btn} text-zinc-400 hover:bg-zinc-800 hover:text-white`}>
                              cancel
                            </button>
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </>
            )}
            <p className="text-[11px] text-zinc-600">Orders go to your own broker account. Nothing here is investment advice.</p>
          </div>
        </section>
      )}

      {ticket && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={() => ticket.step !== 'sending' && setTicket(null)}>
          <div role="dialog" aria-label={`Order ticket for ${ticket.symbol}`} className="w-full max-w-sm rounded border border-amber-400/60 bg-zinc-950 p-4 text-[13px]" onClick={(e) => e.stopPropagation()}>
            <div className="mb-3 flex items-center gap-2">
              <span className="font-semibold text-amber-300">
                {ticket.side === 'buy' ? 'Buy' : 'Sell'} {ticket.symbol}
              </span>
              {account?.broker && <span className={`rounded px-1.5 text-[11px] font-semibold ${live ? 'bg-red-500 text-white' : 'bg-zinc-700 text-zinc-200'}`}>{live ? 'LIVE' : 'PAPER'}</span>}
              <span className="ml-auto text-xs text-zinc-500">{account?.label ?? ''}</span>
            </div>

            {!ready && (
              <p className="mb-3 text-amber-200">
                {account?.locked ? (
                  <>
                    Trading is locked.{' '}
                    <Link href="/settings" className="underline">
                      Unlock it in Settings
                    </Link>
                    .
                  </>
                ) : account?.error ? (
                  account.error
                ) : account && !account.brokers.length ? (
                  <>
                    No broker linked.{' '}
                    <Link href="/settings?tab=plugins" className="underline">
                      Add Alpaca or moomoo in Settings
                    </Link>
                    .
                  </>
                ) : (
                  'Loading your account…'
                )}
              </p>
            )}

            {ticket.step === 'edit' && (
              <form
                className="space-y-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  review();
                }}
              >
                <div className="flex gap-1">
                  {(['buy', 'sell'] as const).map((s) => (
                    <button
                      key={s}
                      type="button"
                      aria-pressed={ticket.side === s}
                      onClick={() => setTicket({ ...ticket, side: s, error: undefined })}
                      className={`flex-1 rounded px-2 py-1 ${ticket.side === s ? (s === 'buy' ? 'bg-emerald-500 text-zinc-950' : 'bg-red-500 text-white') : 'border border-zinc-700 text-zinc-400'}`}
                    >
                      {s}
                    </button>
                  ))}
                </div>
                <div className="flex items-end gap-2">
                  <label className="flex-1 text-xs text-zinc-500">
                    {ticket.sizeBy === 'usd' ? 'Dollars' : 'Shares'}
                    <input
                      autoFocus
                      inputMode="decimal"
                      value={ticket.size}
                      onChange={(e) => setTicket({ ...ticket, size: e.target.value, error: undefined })}
                      className="mt-0.5 block w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-zinc-100 focus:border-amber-400 focus:outline-none"
                    />
                  </label>
                  {account?.fractional && ticket.type === 'market' && (
                    <button
                      type="button"
                      onClick={() => setTicket({ ...ticket, sizeBy: ticket.sizeBy === 'usd' ? 'shares' : 'usd', size: '', error: undefined })}
                      className="rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-400 hover:text-zinc-100"
                    >
                      by {ticket.sizeBy === 'usd' ? 'shares' : 'dollars'}
                    </button>
                  )}
                </div>
                <div className="flex gap-2">
                  <label className="flex-1 text-xs text-zinc-500">
                    Type
                    <select
                      value={ticket.type}
                      onChange={(e) => {
                        const type = e.target.value as 'market' | 'limit';
                        setTicket({ ...ticket, type, sizeBy: type === 'limit' ? 'shares' : ticket.sizeBy, ext: type === 'limit' ? ticket.ext : false, error: undefined });
                      }}
                      className="mt-0.5 block w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-zinc-100"
                    >
                      <option value="market">market</option>
                      <option value="limit">limit</option>
                    </select>
                  </label>
                  {ticket.type === 'limit' && (
                    <label className="flex-1 text-xs text-zinc-500">
                      Limit price
                      <input
                        inputMode="decimal"
                        value={ticket.limit}
                        placeholder={lastOf(ticket.symbol) != null ? String(lastOf(ticket.symbol)) : ''}
                        onChange={(e) => setTicket({ ...ticket, limit: e.target.value, error: undefined })}
                        className="mt-0.5 block w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-zinc-100 focus:border-amber-400 focus:outline-none"
                      />
                    </label>
                  )}
                  <label className="text-xs text-zinc-500">
                    Good for
                    <select value={ticket.tif} onChange={(e) => setTicket({ ...ticket, tif: e.target.value as 'day' | 'gtc' })} className="mt-0.5 block rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-zinc-100">
                      <option value="day">day</option>
                      <option value="gtc">until canceled</option>
                    </select>
                  </label>
                </div>
                {ticket.type === 'limit' && (
                  <label className="flex items-center gap-2 text-xs text-zinc-400">
                    <input type="checkbox" checked={ticket.ext} onChange={(e) => setTicket({ ...ticket, ext: e.target.checked })} />
                    Allow pre-market and after-hours fills
                  </label>
                )}
                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
                  <dt className="text-zinc-500">Last close</dt>
                  <dd className="text-right tabular-nums text-zinc-300">{lastOf(ticket.symbol) != null ? formatValue(lastOf(ticket.symbol), 'num', 2) : 'not on your watchlist'}</dd>
                  <dt className="text-zinc-500">You hold</dt>
                  <dd className="text-right tabular-nums text-zinc-300">{held.get(ticket.symbol) ?? 0}</dd>
                  <dt className="text-zinc-500">Buying power</dt>
                  <dd className="text-right tabular-nums text-zinc-300">{usd(account?.buyingPowerUsd)}</dd>
                  {est > 0 && (
                    <>
                      <dt className="text-zinc-500">About</dt>
                      <dd className="text-right tabular-nums text-zinc-300">{usd(est)}</dd>
                    </>
                  )}
                </dl>
                {ticket.error && <p className="text-xs text-red-400">{ticket.error}</p>}
                <div className="flex justify-end gap-2 pt-1">
                  <button type="button" onClick={() => setTicket(null)} className="rounded border border-zinc-700 px-3 py-1 text-zinc-400 hover:text-zinc-100">
                    cancel
                  </button>
                  <button type="submit" disabled={!ready} className="rounded bg-amber-400 px-3 py-1 font-semibold text-zinc-950 hover:bg-amber-300 disabled:opacity-40">
                    review
                  </button>
                </div>
              </form>
            )}

            {(ticket.step === 'review' || ticket.step === 'sending') && ticketOrder?.ok && (
              <div className="space-y-2">
                <p className="text-zinc-100">{describeOrder(ticketOrder.order)}</p>
                <p className="text-xs text-zinc-500">
                  {account?.label} · {live ? 'real money' : 'paper account, no real money'}
                  {est > 0 ? ` · about ${usd(est)}` : ''}
                  {ticketOrder.order.type === 'market' ? ' · a market order fills at the next available price' : ''}
                </p>
                {ticket.result?.needsConfirm && (
                  <div className="rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-xs text-amber-200">
                    <div className="font-semibold">{account?.label} asks you to confirm:</div>
                    <div>{ticket.result.message}</div>
                    {ticket.result.needsConfirm.url && (
                      <a href={ticket.result.needsConfirm.url} target="_blank" rel="noopener noreferrer" className="underline">
                        Open at {account?.label} ↗
                      </a>
                    )}
                  </div>
                )}
                {live && !ticket.result?.needsConfirm && (
                  <label className="flex items-start gap-2 text-xs text-red-300">
                    <input type="checkbox" className="mt-0.5" checked={ticket.liveAck} onChange={(e) => setTicket({ ...ticket, liveAck: e.target.checked })} />
                    This is a real order with real money on my {account?.label} account.
                  </label>
                )}
                <div className="flex justify-end gap-2 pt-1">
                  <button type="button" disabled={ticket.step === 'sending'} onClick={() => setTicket({ ...ticket, step: 'edit', result: undefined })} className="rounded border border-zinc-700 px-3 py-1 text-zinc-400 hover:text-zinc-100 disabled:opacity-40">
                    back
                  </button>
                  {ticket.result?.needsConfirm ? (
                    <button type="button" disabled={ticket.step === 'sending'} onClick={() => void confirm()} className="rounded bg-amber-400 px-3 py-1 font-semibold text-zinc-950 hover:bg-amber-300 disabled:opacity-40">
                      {ticket.step === 'sending' ? 'sending…' : 'confirm and send'}
                    </button>
                  ) : (
                    <button
                      type="button"
                      disabled={ticket.step === 'sending' || (live && !ticket.liveAck)}
                      onClick={() => void place()}
                      className={`rounded px-3 py-1 font-semibold disabled:opacity-40 ${ticket.side === 'buy' ? 'bg-emerald-500 text-zinc-950 hover:bg-emerald-400' : 'bg-red-500 text-white hover:bg-red-400'}`}
                    >
                      {ticket.step === 'sending' ? 'sending…' : `place ${live ? 'live' : 'paper'} order`}
                    </button>
                  )}
                </div>
              </div>
            )}

            {ticket.step === 'done' && (
              <div className="space-y-2">
                <p className="text-emerald-300">Order sent: {ticket.result?.status ?? 'accepted'}</p>
                <p className="text-xs text-zinc-500">{ticket.result?.message}</p>
                <div className="flex justify-end">
                  <button type="button" autoFocus onClick={() => setTicket(null)} className="rounded bg-amber-400 px-3 py-1 font-semibold text-zinc-950 hover:bg-amber-300">
                    done
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </aside>
  );
}
