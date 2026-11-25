'use client';

/**
 * /terminal: the research terminal in the browser.
 *
 * Sidebar of dashboards, tabs, one input bar that drives every card on the
 * tab, and a grid of cards. The cards are the same ones `b1dz research` shows
 * in a terminal; this page only lays them out. Data comes from
 * /api/research/card/<id>, which needs a signed-in user.
 *
 * The right-hand panel (watch-panel.tsx) holds the user's watchlist, their
 * broker account and the order ticket.
 */
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { TRANSFORMS, TRANSFORM_LABEL, type Transform } from '@b1dz/research/transform';
import type { CardResult } from '@b1dz/research/types';
import { isOrderSymbol } from '@b1dz/core/terminal';
import { BlockView } from './blocks';
import { WatchPanel, type WatchPanelHandle } from './watch-panel';
import { TvTile, type TvTileHandle } from './tv-tile';
import { AnalystBox } from './analyst-box';
import {
  PRIMARY_PARAMS,
  RANGES,
  cardKey,
  cardUrl,
  groupDashboards,
  localSearch,
  paramsForCard,
  searchFromView,
  tabParams,
  viewFromSearch,
  type Catalog,
  type CatalogCard,
  type CatalogParam,
  type View,
} from './logic';

const MY = 'my';
const LS_PARAMS = 'b1dz:terminal:params';
const LS_PINNED = 'b1dz:terminal:pinned';
const LS_LAST = 'b1dz:terminal:last';
const LS_WATCH_OPEN = 'b1dz:terminal:watch-open';
const LS_TV_OPEN = 'b1dz:terminal:tv-open';

interface Run extends CardResult {
  id: string;
  title: string;
  source: string;
  params: Record<string, string>;
}
interface Loaded {
  status: 'loading' | 'ok' | 'error' | 'key' | 'auth';
  run?: Run;
  message?: string;
}
interface Pinned {
  id: string;
  params: Record<string, string>;
}
interface Hit {
  label: string;
  detail?: string;
  dashboard: string;
  tab?: string;
  params?: Record<string, string>;
  kind?: string;
}

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function writeJson(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode or quota: the terminal still works, it just forgets */
  }
}

const HELP: [string, string][] = [
  ['/', 'search: ticker, company, CIK, dataset, dashboard'],
  ['[  ]', 'previous / next tab'],
  ['1 - 9', 'jump to tab'],
  ['s', 'focus the main input (symbol, country, query)'],
  ['<  >', 'shorter / longer date range'],
  ['t', 'chart transform: level, indexed, YoY %, drawdown'],
  ['r', 'reload the cards on this tab'],
  ['w', 'show or hide the watchlist and your broker account'],
  ['a', 'add the current symbol to the watchlist'],
  ['b  x', 'buy / sell the current symbol (opens the order ticket)'],
  ['v', 'live TV: CNBC, Bloomberg, Fox Business from your hdtilt.com account'],
  [',  .', 'previous / next TV channel'],
  ['Esc', 'close search, help or a maximized card'],
  ['?', 'this help'],
];

export function TerminalClient({ catalog, signedIn }: { catalog: Catalog; signedIn: boolean }) {
  const cards = useMemo(() => new Map(catalog.cards.map((c) => [c.id, c])), [catalog]);
  const [pinned, setPinned] = useState<Pinned[]>([]);
  const [view, setView] = useState<View>(() => viewFromSearch('', catalog));
  const [ready, setReady] = useState(false);
  const [transform, setTransform] = useState<Transform>('level');
  const [maximized, setMaximized] = useState<number | null>(null);
  const [results, setResults] = useState<Record<string, Loaded>>({});
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [help, setHelp] = useState(false);
  const [menu, setMenu] = useState(false);
  const [note, setNote] = useState('');
  const [watchOpen, setWatchOpen] = useState(false);
  const watch = useRef<WatchPanelHandle>(null);
  const [tvOpen, setTvOpen] = useState(false);
  const tv = useRef<TvTileHandle>(null);

  const resultsRef = useRef<Record<string, Loaded>>({});
  const queue = useRef<(() => Promise<void>)[]>([]);
  const active = useRef(0);
  const searchBox = useRef<HTMLInputElement>(null);
  const paramBar = useRef<HTMLDivElement>(null);

  // Restore the last view, saved inputs and pinned cards once the browser is available.
  useEffect(() => {
    // Back from connecting hdtilt: ?tv=<outcome> is ours, not a card input.
    const arrived = new URLSearchParams(window.location.search);
    const tvOutcome = arrived.get('tv');
    if (tvOutcome) {
      arrived.delete('tv');
      const rest = arrived.toString();
      window.history.replaceState(null, '', `${window.location.pathname}${rest ? `?${rest}` : ''}`);
    }
    const saved = readJson<Record<string, Record<string, string>>>(LS_PARAMS, {});
    const last = readJson<Partial<View>>(LS_LAST, {});
    const fromUrl = viewFromSearch(window.location.search, catalog, last);
    const explicit = new URLSearchParams(window.location.search).has('d');
    setPinned(readJson<Pinned[]>(LS_PINNED, []));
    // Open by default where there is room for it; remembered after that.
    // On a phone the panel covers the page, so it only opens when asked.
    setWatchOpen(window.matchMedia('(min-width: 768px)').matches && readJson<boolean>(LS_WATCH_OPEN, window.matchMedia('(min-width: 1280px)').matches));
    setView({ ...fromUrl, params: explicit ? { ...saved[fromUrl.dashboard], ...fromUrl.params } : (saved[fromUrl.dashboard] ?? {}) });
    if (tvOutcome) {
      setTvOpen(true);
      writeJson(LS_TV_OPEN, true);
      const said: Record<string, string> = { connected: 'hdtilt connected', denied: 'hdtilt was not connected', badstate: 'the hdtilt sign-in expired: try again', failed: 'hdtilt did not finish the sign-in: try again' };
      setNote(said[tvOutcome] ?? '');
    } else setTvOpen(readJson<boolean>(LS_TV_OPEN, false));
    setReady(true);
  }, [catalog]);

  const dashboards = useMemo(
    () =>
      pinned.length
        ? [...catalog.dashboards, { id: MY, title: 'My dashboard', group: 'Custom', tabs: [{ id: 'cards', title: 'Pinned cards', cards: pinned.map((p) => p.id) }] }]
        : catalog.dashboards,
    [catalog, pinned],
  );
  const dashboard = dashboards.find((d) => d.id === view.dashboard) ?? dashboards[0];
  const tab = dashboard?.tabs.find((t) => t.id === view.tab) ?? dashboard?.tabs[0];
  const isMine = dashboard?.id === MY;

  /** The cards on screen, each with the params it will be run with. */
  const shown = useMemo(() => {
    if (!dashboard || !tab) return [] as { card: CatalogCard; params: Record<string, string> }[];
    if (isMine) return pinned.flatMap((p) => (cards.get(p.id) ? [{ card: cards.get(p.id)!, params: p.params }] : []));
    return tab.cards.flatMap((id) => (cards.get(id) ? [{ card: cards.get(id)!, params: paramsForCard(cards.get(id), view.params) }] : []));
  }, [dashboard, tab, isMine, pinned, cards, view.params]);
  const specs = useMemo(() => (isMine || !tab ? [] : tabParams(tab.cards, cards)), [isMine, tab, cards]);

  // Keep the address bar shareable and remember where the user was.
  useEffect(() => {
    if (!ready || !dashboard) return;
    const next = { dashboard: dashboard.id, tab: tab?.id ?? '', params: view.params };
    window.history.replaceState(null, '', `${window.location.pathname}${searchFromView(next)}`);
    writeJson(LS_LAST, { dashboard: next.dashboard, tab: next.tab });
    if (!isMine) writeJson(LS_PARAMS, { ...readJson<Record<string, Record<string, string>>>(LS_PARAMS, {}), [dashboard.id]: view.params });
  }, [ready, dashboard, tab, view.params, isMine]);

  // ---- loading: four cards at a time --------------------------------------
  const put = useCallback((key: string, value: Loaded | undefined) => {
    const next = { ...resultsRef.current };
    if (value) next[key] = value;
    else delete next[key];
    resultsRef.current = next;
    setResults(next);
  }, []);
  const pump = useCallback(() => {
    while (active.current < 4 && queue.current.length) {
      const job = queue.current.shift()!;
      active.current++;
      void job().finally(() => {
        active.current--;
        pump();
      });
    }
  }, []);
  const load = useCallback(
    (id: string, params: Record<string, string>) => {
      const key = cardKey(id, params);
      if (resultsRef.current[key]) return;
      put(key, { status: 'loading' });
      queue.current.push(async () => {
        try {
          const res = await fetch(cardUrl(id, params), { credentials: 'same-origin', headers: { accept: 'application/json' } });
          const body = (await res.json().catch(() => ({}))) as Run & { error?: string };
          if (res.ok) put(key, { status: 'ok', run: body });
          else put(key, { status: res.status === 401 ? 'auth' : res.status === 424 ? 'key' : 'error', message: body.error ?? `HTTP ${res.status}` });
        } catch (e) {
          put(key, { status: 'error', message: (e as Error).message || 'network error' });
        }
      });
      pump();
    },
    [put, pump],
  );
  useEffect(() => {
    if (!ready || !signedIn) return;
    for (const s of shown) load(s.card.id, s.params);
  }, [ready, signedIn, shown, load]);

  // ---- actions -------------------------------------------------------------
  const flash = useCallback((text: string) => {
    setNote(text);
    window.setTimeout(() => setNote((n) => (n === text ? '' : n)), 4000);
  }, []);
  const go = useCallback(
    (dashboardId: string, tabId?: string, params?: Record<string, string>) => {
      const saved = readJson<Record<string, Record<string, string>>>(LS_PARAMS, {});
      const d = dashboards.find((x) => x.id === dashboardId);
      if (!d) return;
      setView({ dashboard: d.id, tab: d.tabs.find((t) => t.id === tabId)?.id ?? d.tabs[0]?.id ?? '', params: { ...saved[d.id], ...params } });
      setMaximized(null);
      setHits(null);
      setQuery('');
      setMenu(false);
    },
    [dashboards],
  );
  const setParam = useCallback((name: string, value: string) => {
    const v = name === 'symbol' || name === 'symbols' ? value.toUpperCase() : value;
    setView((cur) => {
      const params = { ...cur.params };
      if (v.trim()) params[name] = v.trim();
      else delete params[name];
      return { ...cur, params };
    });
  }, []);
  const moveTab = useCallback(
    (step: number, absolute = false) => {
      if (!dashboard) return;
      const n = dashboard.tabs.length;
      const at = Math.max(0, dashboard.tabs.findIndex((t) => t.id === tab?.id));
      const next = absolute ? step : (at + step + n) % n;
      if (next < 0 || next >= n) return;
      setView((cur) => ({ ...cur, tab: dashboard.tabs[next].id }));
      setMaximized(null);
    },
    [dashboard, tab],
  );
  const reload = useCallback(() => {
    for (const s of shown) put(cardKey(s.card.id, s.params), undefined);
    for (const s of shown) load(s.card.id, s.params);
    flash('reloading…');
  }, [shown, put, load, flash]);
  const pin = useCallback(
    (id: string, params: Record<string, string>) => {
      const next = [...pinned, { id, params }];
      setPinned(next);
      writeJson(LS_PINNED, next);
      flash('pinned to My dashboard');
    },
    [pinned, flash],
  );
  const unpin = useCallback(
    (index: number) => {
      const next = pinned.filter((_, i) => i !== index);
      setPinned(next);
      writeJson(LS_PINNED, next);
      if (!next.length) go(catalog.dashboards[0]?.id ?? '');
    },
    [pinned, go, catalog],
  );

  const toggleWatch = useCallback((next?: boolean) => {
    setWatchOpen((cur) => {
      const open = next ?? !cur;
      writeJson(LS_WATCH_OPEN, open);
      return open;
    });
  }, []);
  const toggleTv = useCallback((next?: boolean) => {
    setTvOpen((cur) => {
      const open = next ?? !cur;
      writeJson(LS_TV_OPEN, open);
      return open;
    });
  }, []);
  /** The ticker the current tab is about, when it has one. */
  const currentSymbol = (view.params.symbol ?? '').trim().toUpperCase();
  const tradeCurrent = useCallback(
    (side: 'buy' | 'sell') => {
      if (!signedIn) return flash('sign in to trade');
      if (!currentSymbol) return flash('no symbol on this tab: open a company first');
      if (!isOrderSymbol(currentSymbol)) return flash(`${currentSymbol} is not a stock or ETF a broker can trade`);
      toggleWatch(true);
      watch.current?.trade(currentSymbol, side);
    },
    [signedIn, currentSymbol, flash, toggleWatch],
  );

  const runSearch = useCallback(async () => {
    const q = query.trim();
    if (!q) return;
    const local: Hit[] = localSearch(catalog, q);
    if (!signedIn) return setHits(local);
    setSearching(true);
    try {
      const res = await fetch(`/api/research/search?q=${encodeURIComponent(q)}`, { credentials: 'same-origin' });
      const body = (await res.json().catch(() => ({}))) as { hits?: Hit[] };
      setHits(res.ok && body.hits?.length ? body.hits : local);
    } catch {
      setHits(local);
    } finally {
      setSearching(false);
    }
  }, [query, catalog, signedIn]);

  // ---- keys ----------------------------------------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const typing = !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
      if (e.key === 'Escape') {
        if (typing) el!.blur();
        setHits(null);
        setHelp(false);
        setMaximized(null);
        setMenu(false);
        return;
      }
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === '/') {
        e.preventDefault();
        searchBox.current?.focus();
      } else if (e.key === '?') setHelp((h) => !h);
      else if (e.key === '[') moveTab(-1);
      else if (e.key === ']') moveTab(1);
      else if (/^[1-9]$/.test(e.key)) moveTab(Number(e.key) - 1, true);
      else if (e.key === 't') {
        const next = TRANSFORMS[(TRANSFORMS.indexOf(transform) + 1) % TRANSFORMS.length];
        setTransform(next);
        flash(`charts: ${TRANSFORM_LABEL[next]}`);
      } else if (e.key === 'r') reload();
      else if (e.key === 'w') toggleWatch();
      else if (e.key === 'v') toggleTv();
      else if (e.key === ',' || e.key === '.') tv.current?.zap(e.key === '.' ? 1 : -1);
      else if (e.key === 'a') {
        if (!currentSymbol) return flash('no symbol on this tab to add');
        toggleWatch(true);
        watch.current?.add(currentSymbol);
      } else if (e.key === 'b' || e.key === 'x') {
        // The ticket focuses its quantity box at once: without this the key itself is typed into it.
        e.preventDefault();
        tradeCurrent(e.key === 'b' ? 'buy' : 'sell');
      }
      else if (e.key === 's') {
        const name = PRIMARY_PARAMS.find((n) => specs.some((p) => p.name === n)) ?? specs[0]?.name;
        const input = name ? paramBar.current?.querySelector<HTMLElement>(`[data-param="${name}"]`) : null;
        if (input) {
          e.preventDefault();
          input.focus();
        }
      } else if (e.key === '<' || e.key === '>') {
        const spec = specs.find((p) => p.name === 'range');
        if (!spec) return flash('no date range on this tab');
        const cur = RANGES.indexOf((view.params.range ?? spec.default ?? '1Y').toUpperCase());
        const next = RANGES[(Math.max(0, cur) + (e.key === '>' ? 1 : -1) + RANGES.length) % RANGES.length];
        setParam('range', next);
        flash(`range ${next}`);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [moveTab, reload, flash, transform, specs, view.params.range, setParam, toggleWatch, toggleTv, currentSymbol, tradeCurrent]);

  const loginHref = `/login?next=${encodeURIComponent(`/terminal${searchFromView({ dashboard: dashboard?.id ?? '', tab: tab?.id ?? '', params: view.params })}`)}`;
  const loadingCount = Object.values(results).filter((r) => r.status === 'loading').length;
  const visible = maximized !== null && shown[maximized] ? [{ ...shown[maximized], index: maximized }] : shown.map((s, index) => ({ ...s, index }));

  return (
    <div className="relative flex min-h-0 flex-1 font-mono text-[13px]">
      {/* sidebar */}
      <aside className={`${menu ? 'absolute inset-y-0 left-0 z-30 flex' : 'hidden'} w-60 shrink-0 flex-col overflow-y-auto border-r border-zinc-800 bg-zinc-950 py-2 md:static md:flex`}>
        <nav aria-label="Dashboards">
          {groupDashboards(dashboards).map((g) => (
            <div key={g.group} className="mb-2">
              <div className="px-3 pb-0.5 text-[11px] font-semibold uppercase tracking-wide text-cyan-400/80">{g.group}</div>
              {g.items.map((d) => (
                <button
                  key={d.id}
                  type="button"
                  onClick={() => go(d.id)}
                  aria-current={d.id === dashboard?.id ? 'page' : undefined}
                  className={`block w-full truncate px-4 py-[3px] text-left ${d.id === dashboard?.id ? 'bg-zinc-800 text-amber-300' : 'text-zinc-300 hover:bg-zinc-900'}`}
                >
                  {d.title}
                </button>
              ))}
            </div>
          ))}
        </nav>
      </aside>

      <section className="flex min-w-0 flex-1 flex-col">
        {/* command row */}
        <div className="relative flex items-center gap-2 border-b border-zinc-800 px-3 py-1.5">
          <button type="button" className="rounded border border-zinc-700 px-2 py-0.5 text-zinc-300 md:hidden" onClick={() => setMenu((m) => !m)} aria-expanded={menu}>
            ☰
          </button>
          <span className="hidden truncate text-zinc-500 sm:inline">
            {dashboard?.group} › <span className="text-zinc-200">{dashboard?.title}</span>
          </span>
          <form
            className="ml-auto flex w-full max-w-md items-center gap-1"
            onSubmit={(e) => {
              e.preventDefault();
              void runSearch();
            }}
          >
            <label htmlFor="terminal-search" className="text-zinc-500">
              /
            </label>
            <input
              id="terminal-search"
              ref={searchBox}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setHits(e.target.value.trim() ? localSearch(catalog, e.target.value) : null);
              }}
              placeholder={signedIn ? 'ticker, company, CIK, dataset, dashboard' : 'dashboard or card (sign in to search tickers)'}
              autoComplete="off"
              spellCheck={false}
              className="w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-0.5 text-zinc-100 placeholder:text-zinc-600 focus:border-amber-400 focus:outline-none"
            />
          </form>
          <button
            type="button"
            onClick={() => toggleWatch()}
            aria-pressed={watchOpen}
            className={`whitespace-nowrap rounded border px-2 py-0.5 ${watchOpen ? 'border-amber-400/60 text-amber-300' : 'border-zinc-700 text-zinc-400 hover:text-zinc-100'}`}
            title="Watchlist and trading (w)"
          >
            watch
          </button>
          <button
            type="button"
            onClick={() => toggleTv()}
            aria-pressed={tvOpen}
            className={`whitespace-nowrap rounded border px-2 py-0.5 ${tvOpen ? 'border-amber-400/60 text-amber-300' : 'border-zinc-700 text-zinc-400 hover:text-zinc-100'}`}
            title="Live TV: CNBC, Bloomberg, Fox Business (v)"
          >
            tv
          </button>
          <button type="button" onClick={() => setHelp(true)} className="rounded border border-zinc-700 px-2 py-0.5 text-zinc-400 hover:text-zinc-100" aria-label="Keyboard help">
            ?
          </button>
          {hits && (
            <ul className="absolute right-3 top-full z-20 mt-1 max-h-96 w-[min(34rem,calc(100vw-1.5rem))] overflow-y-auto rounded border border-zinc-700 bg-zinc-900 shadow-xl">
              {searching && <li className="px-3 py-1 text-zinc-500">searching…</li>}
              {!searching && !hits.length && <li className="px-3 py-1 text-zinc-500">nothing found{signedIn ? '' : '; sign in to search tickers and companies'}</li>}
              {hits.map((h, i) => (
                <li key={i}>
                  <button type="button" onClick={() => go(h.dashboard, h.tab, h.params)} className="flex w-full items-baseline gap-2 px-3 py-1 text-left hover:bg-zinc-800">
                    <span className="truncate text-zinc-100">{h.label}</span>
                    {h.detail && <span className="truncate text-xs text-zinc-500">{h.detail}</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* tabs */}
        <div className="flex gap-1 overflow-x-auto border-b border-zinc-800 px-2 py-1" role="tablist" aria-label="Tabs">
          {dashboard?.tabs.map((t, i) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={t.id === tab?.id}
              onClick={() => moveTab(i, true)}
              className={`whitespace-nowrap rounded px-2 py-0.5 ${t.id === tab?.id ? 'bg-amber-400 text-zinc-950' : 'text-zinc-300 hover:bg-zinc-900'}`}
            >
              <span className={t.id === tab?.id ? 'opacity-60' : 'text-zinc-600'}>{i + 1}</span> {t.title}
            </button>
          ))}
        </div>

        {/* inputs */}
        {specs.length > 0 && (
          <div ref={paramBar} className="flex flex-wrap items-end gap-x-4 gap-y-1 border-b border-zinc-800 px-3 py-1.5">
            {specs.map((p) => (
              <ParamInput key={`${dashboard?.id}-${p.name}`} spec={p} value={view.params[p.name] ?? ''} onChange={(v) => setParam(p.name, v)} />
            ))}
            {currentSymbol && (
              <span className="flex gap-1 pb-0.5 text-xs">
                <button type="button" onClick={() => { toggleWatch(true); watch.current?.add(currentSymbol); }} className="rounded border border-zinc-700 px-1.5 py-0.5 text-zinc-400 hover:text-zinc-100" title="Add to the watchlist (a)">
                  + watch
                </button>
                {signedIn && isOrderSymbol(currentSymbol) && (
                  <>
                    <button type="button" onClick={() => tradeCurrent('buy')} className="rounded border border-emerald-500/50 px-1.5 py-0.5 text-emerald-400 hover:bg-emerald-500/20" title={`Buy ${currentSymbol} (b)`}>
                      buy
                    </button>
                    <button type="button" onClick={() => tradeCurrent('sell')} className="rounded border border-red-500/50 px-1.5 py-0.5 text-red-400 hover:bg-red-500/20" title={`Sell ${currentSymbol} (x)`}>
                      sell
                    </button>
                  </>
                )}
              </span>
            )}
            {transform !== 'level' && <span className="pb-1 text-xs text-amber-300">{TRANSFORM_LABEL[transform]}</span>}
          </div>
        )}

        {/* cards */}
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {!signedIn && (
            <div className="mb-3 rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-amber-200">
              Browse every dashboard below.{' '}
              <Link href={loginHref} className="underline">
                Sign in
              </Link>{' '}
              or{' '}
              <Link href="/signup" className="underline">
                create a free account
              </Link>{' '}
              to load live data. Prefer a real terminal? Install the CLI and run <code className="text-amber-100">b1dz</code>: the same terminal, no account needed for research.
            </div>
          )}
          <AnalystBox cards={shown.map(({ card, params }) => ({ id: card.id, params }))} signedIn={signedIn} loginHref={loginHref} />
          <div className={maximized === null ? 'grid grid-cols-1 gap-3 2xl:grid-cols-2' : ''}>
            {visible.map(({ card, params, index }) => (
              <CardView
                key={`${card.id}-${index}`}
                card={card}
                params={params}
                state={results[cardKey(card.id, params)]}
                signedIn={signedIn}
                loginHref={loginHref}
                full={maximized !== null}
                transform={transform}
                onMaximize={() => setMaximized(maximized === null ? index : null)}
                onPin={isMine ? undefined : () => pin(card.id, params)}
                onUnpin={isMine ? () => unpin(index) : undefined}
              />
            ))}
          </div>
          {!shown.length && <div className="text-zinc-500">No cards on this tab.</div>}
        </div>

        {/* status */}
        <div className="flex items-center gap-3 border-t border-zinc-800 px-3 py-1 text-xs text-zinc-500">
          <span className={note ? 'text-amber-300' : 'hidden md:inline'}>{note || '/ search · [ ] tabs · s input · < > range · t transform · r reload · w watchlist · b buy · x sell · v tv · ? help'}</span>
          <span className="ml-auto">{loadingCount ? `loading ${loadingCount}…` : 'Research only. Quotes can be delayed. Not investment advice.'}</span>
        </div>
      </section>

      <WatchPanel
        ref={watch}
        open={watchOpen}
        signedIn={signedIn}
        loginHref={loginHref}
        onClose={() => toggleWatch(false)}
        onOpenSymbol={(symbol) => {
          go('company', 'overview', { symbol });
          if (window.matchMedia('(max-width: 767px)').matches) toggleWatch(false);
        }}
        flash={flash}
      />

      {ready && <TvTile ref={tv} open={tvOpen} onClose={() => toggleTv(false)} flash={flash} />}

      {help && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/70 p-4" onClick={() => setHelp(false)}>
          <div role="dialog" aria-label="Keyboard help" className="w-full max-w-lg rounded border border-amber-400/60 bg-zinc-950 p-4" onClick={(e) => e.stopPropagation()}>
            <div className="mb-2 font-semibold text-amber-300">Keys</div>
            <dl className="grid grid-cols-[5rem_1fr] gap-y-1">
              {HELP.map(([k, v]) => (
                <div key={k} className="contents">
                  <dt className="text-cyan-300">{k}</dt>
                  <dd className="text-zinc-300">{v}</dd>
                </div>
              ))}
            </dl>
            <p className="mt-3 text-xs text-zinc-500">
              Each card names its source. Pin a card to build your own dashboard. Orders go through your own broker, linked in Settings. The same terminal runs in a real terminal: install the CLI and run <code>b1dz</code>.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

function ParamInput({ spec, value, onChange }: { spec: CatalogParam; value: string; onChange: (v: string) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const id = `param-${spec.name}`;
  const label = (
    <label htmlFor={id} className="block text-[11px] text-zinc-500">
      {spec.label}
    </label>
  );
  if (spec.name === 'range' && spec.choices?.length) {
    const cur = (value || spec.default || '').toUpperCase();
    return (
      <div>
        <div className="text-[11px] text-zinc-500">{spec.label}</div>
        <div className="flex gap-0.5" data-param={spec.name} tabIndex={-1}>
          {spec.choices.map((c) => (
            <button key={c} type="button" onClick={() => onChange(c)} aria-pressed={c === cur} className={`rounded px-1.5 py-0.5 ${c === cur ? 'bg-zinc-700 text-amber-300' : 'text-zinc-400 hover:bg-zinc-900'}`}>
              {c}
            </button>
          ))}
        </div>
      </div>
    );
  }
  if (spec.choices?.length) {
    return (
      <div>
        {label}
        <select id={id} data-param={spec.name} value={value || spec.default || ''} onChange={(e) => onChange(e.target.value)} className="rounded border border-zinc-700 bg-zinc-900 px-1.5 py-0.5 text-zinc-100 focus:border-amber-400 focus:outline-none">
          {spec.choices.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </div>
    );
  }
  const wide = spec.name === 'symbols' || spec.name === 'query';
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onChange(draft);
        (e.currentTarget.querySelector('input') as HTMLInputElement | null)?.blur();
      }}
    >
      {label}
      <input
        id={id}
        data-param={spec.name}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => draft !== value && onChange(draft)}
        placeholder={spec.default ?? ''}
        title={spec.hint}
        autoComplete="off"
        spellCheck={false}
        className={`${wide ? 'w-72' : 'w-32'} max-w-full rounded border border-zinc-700 bg-zinc-900 px-1.5 py-0.5 text-zinc-100 placeholder:text-zinc-600 focus:border-amber-400 focus:outline-none`}
      />
    </form>
  );
}

function CardView(props: {
  card: CatalogCard;
  params: Record<string, string>;
  state: Loaded | undefined;
  signedIn: boolean;
  loginHref: string;
  full: boolean;
  transform: Transform;
  onMaximize: () => void;
  onPin?: () => void;
  onUnpin?: () => void;
}) {
  const { card, params, state, signedIn, full } = props;
  const run = state?.run;
  const ps = Object.entries(run?.params ?? params).map(([k, v]) => `${k}=${v}`).join(' ');
  const action = 'rounded px-1.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-100';
  return (
    <article className="min-w-0 rounded border border-zinc-800 bg-zinc-950">
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 border-b border-zinc-800 px-3 py-1.5">
        <h2 className="font-semibold text-amber-300">{card.title}</h2>
        {ps && <span className="truncate text-xs text-zinc-500">{ps}</span>}
        <span className="text-xs text-zinc-500">
          Source: {run?.source ?? card.source}
          {run?.asOf ? ` · ${run.asOf}` : ''}
        </span>
        <span className="ml-auto flex items-center gap-0.5 text-xs">
          {run?.sourceUrl && (
            <a href={run.sourceUrl} target="_blank" rel="noopener noreferrer" className={action} title="Open the source page">
              source ↗
            </a>
          )}
          {run && (
            <a href={cardUrl(card.id, params, 'csv')} className={action} title="Download CSV with the source line">
              csv
            </a>
          )}
          {props.onPin && (
            <button type="button" onClick={props.onPin} className={action} title="Pin to My dashboard">
              pin
            </button>
          )}
          {props.onUnpin && (
            <button type="button" onClick={props.onUnpin} className={action} title="Remove from My dashboard">
              unpin
            </button>
          )}
          <button type="button" onClick={props.onMaximize} className={action} title={full ? 'Back to the grid' : 'Maximize'}>
            {full ? 'close' : 'max'}
          </button>
        </span>
      </header>
      <div className="space-y-3 px-3 py-2">
        {!signedIn && (
          <p className="text-xs text-zinc-500">
            {card.description ?? 'Live data from the source named above.'}{' '}
            <Link href={props.loginHref} className="text-amber-300 underline">
              Sign in to load
            </Link>
          </p>
        )}
        {signedIn && (!state || state.status === 'loading') && <p className="animate-pulse text-xs text-zinc-500">loading…</p>}
        {state?.status === 'auth' && (
          <p className="text-xs text-amber-300">
            Your session ended.{' '}
            <Link href={props.loginHref} className="underline">
              Sign in again
            </Link>
          </p>
        )}
        {state?.status === 'key' && <p className="text-xs text-amber-300">This card needs a free provider key that this server does not have yet. It works in the CLI with your own key: {state.message}</p>}
        {state?.status === 'error' && <p className="text-xs text-red-400">Unavailable: {state.message}</p>}
        {run?.blocks.map((b, i) => <BlockView key={i} block={b} full={full} transform={props.transform} />)}
        {run?.notes?.length ? (
          <ul className="space-y-0.5 text-xs text-zinc-500">
            {run.notes.map((n, i) => (
              <li key={i}>• {n}</li>
            ))}
          </ul>
        ) : null}
      </div>
    </article>
  );
}
