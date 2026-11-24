/**
 * `b1dz research`: the market research TUI.
 *
 *   sidebar (dashboards by group) | tabs + cards
 *
 * Every card comes from the @b1dz/research registry. This file only lays
 * them out, loads them a few at a time and handles keys.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import blessed from 'blessed';
import {
  MissingKeyError,
  TRANSFORMS,
  TRANSFORM_LABEL,
  cardToCsv,
  paint,
  renderCard,
  transformChart,
  wrap,
  type CardDef,
  type CardRun,
  type Ctx,
  type DashboardDef,
  type ParamSpec,
  type Registry,
  type SearchHit,
  type Transform,
} from '@b1dz/research';
import { cycle, sideBySide, sidebarItems, visibleLength, windowStart, type SidebarItem } from './layout.js';
import type { ResearchStore } from './store.js';

/* blessed ships no types; the widgets used here are small and stable. */
/* eslint-disable @typescript-eslint/no-explicit-any */
type Widget = any;
const B = blessed as any;

const MY_DASHBOARD = 'my';
const RANGES = ['1M', '3M', '6M', '1Y', '2Y', '5Y', '10Y', 'MAX'];
/** Params tried, in order, by the `s` shortcut. */
const PRIMARY_PARAMS = ['symbol', 'symbols', 'country', 'query', 'series', 'currency'];

export const HELP = `Keys

  Move
    h / Left        focus the dashboard list        l / Right / Enter   focus the cards
    Up / Down, j/k  move in the list, or scroll the cards
    PgUp / PgDn     scroll a page                   g / G               top / bottom
    [ and ]         previous / next tab             1-9                 jump to tab
    Tab / Shift-Tab next / previous card            Enter               maximize the card (Esc to go back)

  Find and set
    /  or Ctrl-G    search: ticker, company, CIK, dataset, dashboard
    s               set the main input of this tab (symbol, country, query)
    p               set any parameter of the cards on this tab
    < and >         shorter / longer date range
    t               chart transform: level, indexed, YoY %, drawdown

  Lists and layout
    w               watchlist: +AAPL adds, -TSLA removes, a name switches list
    c               compare: plot tickers or FRED:SERIES on one axis
    +               pin the focused card to "My dashboard"     -   unpin (in My dashboard)

  Data
    r               reload this tab                 R                   clear the cache and reload
    e               export the focused card to CSV  o                   show the card's source page
    ?               this help                       q / Ctrl-C          quit

Press any key to close.`;

interface ViewCard {
  id: string;
  /** Params fixed for this card (pinned cards); override the dashboard's params. */
  pinned?: Record<string, string>;
}

interface Loaded {
  status: 'loading' | 'ok' | 'error' | 'key';
  run?: CardRun;
  message?: string;
}

export interface ResearchTuiOptions {
  registry: Registry;
  ctx: Ctx;
  store: ResearchStore;
  /** Extra blessed screen options (tests pass input/output streams). */
  screen?: Record<string, unknown>;
  /** Start on this dashboard / tab / params (from the command line). */
  start?: { dashboard?: string; tab?: string; params?: Record<string, string> };
  /** Called instead of process.exit (tests). */
  onQuit?: () => void;
}

export interface ResearchTui {
  screen: Widget;
  /** Resolves when no card is loading. */
  idle(): Promise<void>;
  destroy(): void;
}

export function startResearchTui(opts: ResearchTuiOptions): ResearchTui {
  const { registry, ctx, store } = opts;

  const screen: Widget = B.screen({ smartCSR: true, title: 'b1dz research', fullUnicode: true, forceUnicode: true, dockBorders: true, ...opts.screen });

  const SIDEBAR_W = 30;
  const header: Widget = B.box({ parent: screen, top: 0, left: 0, right: 0, height: 1, tags: true, style: { bg: 'blue', fg: 'white' } });
  const sidebar: Widget = B.box({ parent: screen, top: 1, left: 0, width: SIDEBAR_W, bottom: 1, tags: true, border: { type: 'line' }, style: { border: { fg: 'gray' } } });
  const tabsBar: Widget = B.box({ parent: screen, top: 1, left: SIDEBAR_W, right: 0, height: 1, tags: true });
  const main: Widget = B.box({
    parent: screen, top: 2, left: SIDEBAR_W, right: 0, bottom: 1, tags: true,
    scrollable: true, alwaysScroll: true, mouse: true,
    scrollbar: { ch: ' ', style: { bg: 'gray' } },
    padding: { left: 1, right: 1 },
  });
  const footer: Widget = B.box({ parent: screen, bottom: 0, left: 0, right: 0, height: 1, tags: true, style: { bg: 'black', fg: 'white' } });

  // ---- state -------------------------------------------------------------
  let focus: 'sidebar' | 'main' = 'main';
  let dashIndex = 0;
  let tabIndex = 0;
  let cardIndex = 0;
  let maximized = false;
  let transform: Transform = 'level';
  let modal = false;
  let sidebarTop = 0;
  let message = '';
  let messageTimer: ReturnType<typeof setTimeout> | undefined;
  let renderTimer: ReturnType<typeof setTimeout> | undefined;
  let cardOffsets: number[] = [];
  let destroyed = false;
  const results = new Map<string, Loaded>();
  const queue: (() => Promise<void>)[] = [];
  let running = 0;
  let idleWaiters: (() => void)[] = [];

  // ---- dashboards (registry + the user's pinned cards) -------------------
  function dashboards(): DashboardDef[] {
    const mine: DashboardDef[] = store.state.pinned.length
      ? [{ id: MY_DASHBOARD, title: 'My dashboard', group: 'Custom', tabs: [{ id: 'cards', title: 'Pinned cards', cards: store.state.pinned.map((p) => p.id) }] }]
      : [];
    return [...registry.dashboards, ...mine];
  }
  const dash = (): DashboardDef | undefined => dashboards()[dashIndex];
  const tab = () => dash()?.tabs[tabIndex];
  function viewCards(): ViewCard[] {
    const d = dash();
    if (!d) return [];
    if (d.id === MY_DASHBOARD) return store.state.pinned.map((p) => ({ id: p.id, pinned: p.params }));
    return (tab()?.cards ?? []).filter((id) => registry.card(id)).map((id) => ({ id }));
  }
  function dashParams(): Record<string, string> {
    const d = dash();
    return d ? (store.state.params[d.id] ?? {}) : {};
  }
  function paramsFor(v: ViewCard): Record<string, string> {
    const given: Record<string, string> = { ...dashParams(), ...v.pinned };
    // The watchlist card shows the active list unless symbols were set explicitly.
    if (v.id === 'overview.watchlist' && !v.pinned?.symbols && !dashParams().symbols) given.symbols = store.watchlist().join(',');
    const card = registry.card(v.id);
    return card ? registry.resolveParams(card, given) : {};
  }
  const keyOf = (v: ViewCard) => `${v.id} ${JSON.stringify(paramsFor(v))}`;

  // ---- loading -----------------------------------------------------------
  function pump(): void {
    while (running < 4 && queue.length) {
      const job = queue.shift()!;
      running++;
      void job().finally(() => {
        running--;
        pump();
        if (!running && !queue.length) {
          const waiters = idleWaiters;
          idleWaiters = [];
          waiters.forEach((w) => w());
        }
      });
    }
  }
  function load(v: ViewCard): void {
    const key = keyOf(v);
    if (results.has(key)) return;
    results.set(key, { status: 'loading' });
    const params = paramsFor(v);
    queue.push(async () => {
      try {
        results.set(key, { status: 'ok', run: await registry.run(ctx, v.id, params) });
      } catch (e) {
        results.set(key, { status: e instanceof MissingKeyError ? 'key' : 'error', message: (e as Error).message });
      }
      scheduleRender();
    });
    pump();
  }
  function reload(clearCache: boolean): void {
    if (clearCache) ctx.http.clearCache();
    for (const v of viewCards()) results.delete(keyOf(v));
    if (clearCache) results.clear();
    scheduleRender();
  }

  // ---- rendering ---------------------------------------------------------
  function scheduleRender(): void {
    if (renderTimer || destroyed) return;
    renderTimer = setTimeout(() => {
      renderTimer = undefined;
      render();
    }, 25);
  }

  function say(text: string, ms = 5000): void {
    message = text;
    if (messageTimer) clearTimeout(messageTimer);
    messageTimer = setTimeout(() => {
      message = '';
      scheduleRender();
    }, ms);
    scheduleRender();
  }

  function cardLines(v: ViewCard, width: number, focused: boolean, full: boolean): string[] {
    const def = registry.card(v.id);
    const state = results.get(keyOf(v));
    const run = state?.run;
    const title = def?.title ?? v.id;
    const params = Object.entries(paramsFor(v)).map(([k, val]) => `${k}=${val}`).join(' ');
    const sourceText = `Source: ${run?.source ?? def?.source ?? ''}${run?.asOf ? ` · ${run.asOf}` : ''}`;
    const mark = focused ? '{yellow-fg}▌{/yellow-fg}' : '{gray-fg}▌{/gray-fg}';
    const head = `${mark}${focused ? '{bold}{yellow-fg}' : '{bold}'}${paint(title, undefined, 'blessed')}${focused ? '{/yellow-fg}{/bold}' : '{/bold}'}`;
    const room = width - visibleLength(head) - 2;
    const tail = [params, sourceText].filter(Boolean).join('  ');
    const lines = [`${head}  ${paint(tail.length > room ? tail.slice(0, Math.max(0, room - 1)) + '…' : tail, 'dim', 'blessed')}`];

    if (!state || state.status === 'loading') lines.push(paint('  loading…', 'dim', 'blessed'));
    else if (state.status === 'key') for (const l of wrap(state.message ?? '', width - 2)) lines.push(`  ${paint(l, 'yellow', 'blessed')}`);
    else if (state.status === 'error') for (const l of wrap(`Unavailable: ${state.message ?? 'unknown error'}`, width - 2)) lines.push(`  ${paint(l, 'red', 'blessed')}`);
    else if (run) {
      const shown: CardRun = transform === 'level' ? run : { ...run, blocks: run.blocks.map((b) => (b.kind === 'chart' ? transformChart(b, transform) : b)) };
      const rows = (screen.height as number) - 6;
      const body = renderCard(shown, {
        width: width - 2,
        color: 'blessed',
        chartHeight: full ? Math.max(8, Math.min(24, rows - 14)) : 9,
        maxRows: full ? undefined : 12,
      });
      const cap = full ? body.length : 30;
      for (const l of body.slice(0, cap)) lines.push(`  ${l}`);
      if (body.length > cap) lines.push(paint(`  … ${body.length - cap} more lines (Enter to maximize)`, 'dim', 'blessed'));
    }
    return lines;
  }

  function renderSidebar(items: SidebarItem[]): void {
    const height = Math.max(1, (sidebar.height as number) - 2);
    const selected = items.findIndex((it) => it.kind === 'dashboard' && it.index === dashIndex);
    sidebarTop = windowStart(Math.max(0, selected), height, items.length, sidebarTop);
    const inner = SIDEBAR_W - 2;
    const lines = items.slice(sidebarTop, sidebarTop + height).map((it) => {
      if (it.kind === 'group') return `{cyan-fg}{bold}${paint(it.label.slice(0, inner), undefined, 'blessed')}{/bold}{/cyan-fg}`;
      const label = paint(` ${it.label}`.slice(0, inner).padEnd(inner), undefined, 'blessed');
      if (it.index !== dashIndex) return label;
      return focus === 'sidebar' ? `{inverse}${label}{/inverse}` : `{yellow-fg}{bold}${label}{/bold}{/yellow-fg}`;
    });
    sidebar.setContent(lines.join('\n'));
    sidebar.style.border.fg = focus === 'sidebar' ? 'yellow' : 'gray';
  }

  function render(): void {
    if (destroyed) return;
    const all = dashboards();
    if (dashIndex >= all.length) dashIndex = Math.max(0, all.length - 1);
    const d = dash();
    if (d && tabIndex >= d.tabs.length) tabIndex = 0;
    const cards = viewCards();
    if (cardIndex >= cards.length) cardIndex = Math.max(0, cards.length - 1);

    const ps = Object.entries(dashParams()).map(([k, v]) => `${k}=${v}`).join(' ');
    const right = `${transform === 'level' ? '' : `${TRANSFORM_LABEL[transform]}  `}${ps}`;
    header.setContent(` {bold}b1dz research{/bold}  ${paint(d ? `${d.group} › ${d.title}` : 'no dashboards', undefined, 'blessed')}${right ? `   ${paint(right, undefined, 'blessed')}` : ''}`);
    renderSidebar(sidebarItems(all));

    tabsBar.setContent(
      ' ' +
        (d?.tabs ?? [])
          .map((t, i) => (i === tabIndex ? `{inverse} ${i + 1} ${paint(t.title, undefined, 'blessed')} {/inverse}` : ` {gray-fg}${i + 1}{/gray-fg} ${paint(t.title, undefined, 'blessed')} `))
          .join(''),
    );

    const width = Math.max(40, (main.width as number) - 3);
    const lines: string[] = [];
    cardOffsets = [];
    if (!cards.length) lines.push(paint('No cards on this tab.', 'dim', 'blessed'));
    else if (maximized) {
      const v = cards[cardIndex];
      load(v);
      cardOffsets[cardIndex] = 0;
      lines.push(...cardLines(v, width, true, true));
    } else {
      cards.forEach(load);
      const columns = width >= 150 ? 2 : 1;
      const colW = columns === 2 ? Math.floor((width - 2) / 2) : width;
      for (let i = 0; i < cards.length; i += columns) {
        if (i) lines.push('');
        const left = cardLines(cards[i], colW, i === cardIndex, false);
        cardOffsets[i] = lines.length;
        if (columns === 2 && cards[i + 1]) {
          cardOffsets[i + 1] = lines.length;
          lines.push(...sideBySide(left, cardLines(cards[i + 1], colW, i + 1 === cardIndex, false), colW));
        } else lines.push(...left);
      }
    }
    main.setContent(lines.join('\n'));

    const loading = [...results.values()].filter((r) => r.status === 'loading').length;
    const hint = maximized
      ? 'Esc back · t transform · e export CSV · < > range · ? help'
      : '/ search · s set input · p params · [ ] tabs · Tab card · Enter maximize · w watchlist · c compare · ? help · q quit';
    footer.setContent(` ${message ? `{yellow-fg}${paint(message, undefined, 'blessed')}{/yellow-fg}` : paint(hint, 'dim', 'blessed')}${loading ? `{|}{cyan-fg}loading ${loading}…{/cyan-fg} ` : ''}`);
    screen.render();
  }

  function scrollToCard(): void {
    const at = cardOffsets[cardIndex];
    if (at !== undefined) main.scrollTo(Math.max(0, at));
  }

  // ---- prompts -----------------------------------------------------------
  function ask(label: string, initial = ''): Promise<string | null> {
    return new Promise((resolve) => {
      modal = true;
      const form: Widget = B.box({ parent: screen, bottom: 0, left: 0, right: 0, height: 1, style: { bg: 'yellow', fg: 'black' } });
      B.text({ parent: form, left: 1, content: `${label}:`, style: { bg: 'yellow', fg: 'black', bold: true } });
      const input: Widget = B.textbox({ parent: form, left: label.length + 3, right: 1, height: 1, inputOnFocus: true, style: { bg: 'yellow', fg: 'black' } });
      const done = (value: string | null) => {
        modal = false;
        form.destroy();
        screen.render();
        resolve(value === null ? null : value.trim());
      };
      input.on('submit', (v: string) => done(v ?? ''));
      input.on('cancel', () => done(null));
      input.setValue(initial);
      input.focus();
      screen.render();
    });
  }

  function pick(title: string, labels: string[]): Promise<number | null> {
    return new Promise((resolve) => {
      if (!labels.length) return resolve(null);
      modal = true;
      const list: Widget = B.list({
        parent: screen, top: 'center', left: 'center',
        width: Math.min((screen.width as number) - 4, Math.max(40, ...labels.map((l) => l.length + 6), title.length + 6)),
        height: Math.min((screen.height as number) - 4, labels.length + 2),
        label: ` ${title} `, border: { type: 'line' }, keys: true, vi: true, mouse: true,
        style: { border: { fg: 'yellow' }, selected: { inverse: true } },
        items: labels,
      });
      const done = (i: number | null) => {
        modal = false;
        list.destroy();
        screen.render();
        resolve(i);
      };
      list.on('select', (_item: unknown, i: number) => done(i));
      list.on('cancel', () => done(null));
      list.key(['escape', 'q'], () => done(null));
      list.focus();
      screen.render();
    });
  }

  function showHelp(): void {
    modal = true;
    const box: Widget = B.box({
      parent: screen, top: 'center', left: 'center', width: Math.min((screen.width as number) - 2, 96), height: Math.min((screen.height as number) - 2, HELP.split('\n').length + 2),
      label: ' Help ', border: { type: 'line' }, style: { border: { fg: 'yellow' } }, content: HELP, scrollable: true, keys: true,
    });
    box.focus();
    box.once('keypress', () => {
      modal = false;
      box.destroy();
      screen.render();
    });
    screen.render();
  }

  // ---- actions -----------------------------------------------------------
  function go(dashboardId: string, tabId?: string, params?: Record<string, string>): boolean {
    const i = dashboards().findIndex((d) => d.id === dashboardId);
    if (i < 0) return false;
    dashIndex = i;
    const t = tabId ? dashboards()[i].tabs.findIndex((x) => x.id === tabId) : 0;
    tabIndex = Math.max(0, t);
    cardIndex = 0;
    maximized = false;
    focus = 'main';
    for (const [k, v] of Object.entries(params ?? {})) store.setParam(dashboardId, k, v);
    remember();
    main.scrollTo(0);
    scheduleRender();
    return true;
  }
  function remember(): void {
    const d = dash();
    if (!d) return;
    store.state.last = { dashboard: d.id, tab: tab()?.id ?? '' };
    store.save();
  }
  function tabParams(): ParamSpec[] {
    const seen = new Map<string, ParamSpec>();
    for (const v of viewCards()) for (const p of registry.card(v.id)?.params ?? []) if (!seen.has(p.name)) seen.set(p.name, p);
    return [...seen.values()];
  }
  async function setParam(spec: ParamSpec): Promise<void> {
    const d = dash();
    if (!d) return;
    const current = dashParams()[spec.name] ?? spec.default ?? '';
    let value: string | null;
    if (spec.choices?.length) {
      const i = await pick(spec.label, spec.choices);
      value = i === null ? null : spec.choices[i];
    } else value = await ask(`${spec.label}${spec.hint ? ` (${spec.hint})` : ''}${current ? ` [now ${current}]` : ''}`);
    if (value === null || value === '') return;
    store.setParam(d.id, spec.name, spec.name === 'symbol' || spec.name === 'symbols' ? value.toUpperCase() : value);
    main.scrollTo(0);
    scheduleRender();
  }
  async function search(): Promise<void> {
    const q = await ask('Search (ticker, company, CIK, dataset, dashboard)');
    if (!q) return;
    say(`searching “${q}”…`, 15_000);
    let hits: SearchHit[] = [];
    try {
      hits = await registry.search(ctx, q, 30);
    } catch (e) {
      say(`search failed: ${(e as Error).message}`);
      return;
    }
    if (!hits.length) return say(`nothing found for “${q}”`);
    say('', 1);
    const i = hits.length === 1 ? 0 : await pick(`Results for “${q}”`, hits.map((h) => `${h.kind.padEnd(9)} ${h.label}${h.detail ? `  — ${h.detail}` : ''}`));
    if (i === null) return;
    const h = hits[i];
    if (!go(h.dashboard, h.tab, h.params)) say(`dashboard not available: ${h.dashboard}`);
  }
  function exportCsv(): void {
    const v = viewCards()[cardIndex];
    const state = v && results.get(keyOf(v));
    if (!v || !state?.run) return say('nothing to export yet');
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
    const file = join(process.cwd(), `b1dz-${v.id.replace(/[^a-z0-9]+/gi, '-')}-${stamp}.csv`);
    try {
      writeFileSync(file, cardToCsv(state.run.title, state.run.source, state.run));
      say(`exported ${file}`, 8000);
    } catch (e) {
      say(`export failed: ${(e as Error).message}`);
    }
  }
  function moveDashboard(step: 1 | -1): void {
    const n = dashboards().length;
    if (!n) return;
    dashIndex = (dashIndex + step + n) % n;
    tabIndex = 0;
    cardIndex = 0;
    maximized = false;
    main.scrollTo(0);
    remember();
    scheduleRender();
  }
  function moveTab(step: number, absolute = false): void {
    const n = dash()?.tabs.length ?? 0;
    if (!n) return;
    const next = absolute ? step : (tabIndex + step + n) % n;
    if (next < 0 || next >= n) return;
    tabIndex = next;
    cardIndex = 0;
    maximized = false;
    main.scrollTo(0);
    remember();
    scheduleRender();
  }
  function moveCard(step: 1 | -1): void {
    const n = viewCards().length;
    if (!n) return;
    cardIndex = (cardIndex + step + n) % n;
    render();
    scrollToCard();
    screen.render();
  }
  function quit(): void {
    destroy();
    if (opts.onQuit) opts.onQuit();
    else process.exit(0);
  }
  function destroy(): void {
    if (destroyed) return;
    destroyed = true;
    if (renderTimer) clearTimeout(renderTimer);
    if (messageTimer) clearTimeout(messageTimer);
    screen.destroy();
  }

  // ---- keys --------------------------------------------------------------
  screen.on('keypress', (ch: string | undefined, key: { name?: string; full?: string; ctrl?: boolean; shift?: boolean } = {}) => {
    if (modal || destroyed) return;
    const name = key.name ?? '';
    const full = key.full ?? '';
    const page = Math.max(1, (main.height as number) - 2);

    if (full === 'C-c' || (ch === 'q' && !key.ctrl)) return quit();
    if (ch === '?') return showHelp();
    if (ch === '/' || full === 'C-g') return void search();
    if (name === 'escape') {
      if (maximized) maximized = false;
      else focus = 'main';
      return scheduleRender();
    }

    if (focus === 'sidebar') {
      if (name === 'up' || ch === 'k') return moveDashboard(-1);
      if (name === 'down' || ch === 'j') return moveDashboard(1);
      if (name === 'right' || name === 'enter' || name === 'return' || ch === 'l') {
        focus = 'main';
        return scheduleRender();
      }
    } else {
      if (name === 'left' || ch === 'h') {
        focus = 'sidebar';
        maximized = false;
        return scheduleRender();
      }
      if (name === 'up' || ch === 'k') { main.scroll(-1); return screen.render(); }
      if (name === 'down' || ch === 'j') { main.scroll(1); return screen.render(); }
      if (name === 'enter' || name === 'return') {
        maximized = !maximized;
        main.scrollTo(0);
        return scheduleRender();
      }
    }

    if (name === 'pageup' || full === 'C-u') { main.scroll(-page); return screen.render(); }
    if (name === 'pagedown' || full === 'C-d' || name === 'space') { main.scroll(page); return screen.render(); }
    if (ch === 'g') { main.scrollTo(0); return screen.render(); }
    if (ch === 'G') { main.setScrollPerc(100); return screen.render(); }
    if (ch === '[') return moveTab(-1);
    if (ch === ']') return moveTab(1);
    if (ch && /^[1-9]$/.test(ch)) return moveTab(Number(ch) - 1, true);
    if (name === 'tab') return moveCard(key.shift ? -1 : 1);
    if (ch === 'r') { reload(false); return say('reloading…', 1500); }
    if (ch === 'R') { reload(true); return say('cache cleared, reloading…', 1500); }
    if (ch === 'e') return exportCsv();
    if (ch === 't') {
      transform = cycle(TRANSFORMS, transform, 1);
      return say(`charts: ${TRANSFORM_LABEL[transform]}`, 2000);
    }
    if (ch === 'o') {
      const v = viewCards()[cardIndex];
      const url = v && results.get(keyOf(v))?.run?.sourceUrl;
      return say(url ? `source: ${url}` : 'this card has no source page link', 12_000);
    }
    if (ch === '<' || ch === '>') {
      const spec = tabParams().find((p) => p.name === 'range');
      const d = dash();
      if (!spec || !d) return say('no date range on this tab');
      const next = cycle(RANGES, (dashParams().range ?? spec.default ?? '1Y').toUpperCase(), ch === '>' ? 1 : -1);
      store.setParam(d.id, 'range', next);
      return say(`range ${next}`, 1500);
    }
    if (ch === 's') {
      const specs = tabParams();
      const spec = PRIMARY_PARAMS.map((n) => specs.find((p) => p.name === n)).find(Boolean) ?? specs[0];
      return spec ? void setParam(spec) : say('this tab takes no input');
    }
    if (ch === 'p') {
      const specs = tabParams();
      if (!specs.length) return say('this tab takes no parameters');
      return void pick('Parameters', specs.map((p) => `${p.label.padEnd(18)} ${dashParams()[p.name] ?? p.default ?? ''}`)).then((i) => (i === null ? undefined : setParam(specs[i])));
    }
    if (ch === 'w') {
      return void ask(`Watchlist “${store.state.activeWatchlist}” (+AAPL adds, -TSLA removes, a name switches list)`).then((v) => {
        if (!v) return;
        say(store.editWatchlist(v));
        scheduleRender();
      });
    }
    if (ch === 'c') {
      return void ask('Compare (tickers or FRED:SERIES, comma separated)').then((v) => {
        if (v) go('summary', 'compare', { symbols: v.toUpperCase() });
      });
    }
    if (ch === '+') {
      const v = viewCards()[cardIndex];
      if (!v) return;
      store.pin({ id: v.id, params: paramsFor(v) });
      return say(`pinned “${(registry.card(v.id) as CardDef).title}” to My dashboard`);
    }
    if (ch === '-') {
      if (dash()?.id !== MY_DASHBOARD) return say('- unpins a card; open My dashboard first');
      store.unpin(cardIndex);
      return say('unpinned');
    }
  });

  screen.on('resize', scheduleRender);

  // ---- start -------------------------------------------------------------
  const start = opts.start ?? {};
  const first = start.dashboard ?? store.state.last?.dashboard;
  if (!(first && go(first, start.tab ?? (start.dashboard ? undefined : store.state.last?.tab), start.params))) render();

  return {
    screen,
    idle: () =>
      new Promise<void>((resolve) => {
        // Let a pending render enqueue its cards first.
        setTimeout(() => (running || queue.length ? idleWaiters.push(resolve) : resolve()), 40);
      }),
    destroy,
  };
}
