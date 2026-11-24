import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cycle, padVisible, sideBySide, sidebarItems, visibleLength, windowStart } from './layout.js';
import { DEFAULT_WATCHLIST, ResearchStore } from './store.js';

describe('layout', () => {
  it('measures blessed-tagged text by what is printed', () => {
    expect(visibleLength('{bold}AAPL{/bold}')).toBe(4);
    expect(visibleLength('{green-fg}+1.90%{/green-fg}  x')).toBe(9);
    expect(visibleLength('{open}x{close}')).toBe(3);
    expect(padVisible('{red-fg}ab{/red-fg}', 5)).toBe('{red-fg}ab{/red-fg}   ');
    expect(padVisible('abcdef', 3)).toBe('abcdef');
  });

  it('puts two cards side by side with the left padded to its column', () => {
    expect(sideBySide(['{bold}a{/bold}', 'bb'], ['X', 'Y', 'Z'], 4, 2)).toEqual(['{bold}a{/bold}     X', 'bb    Y', '      Z']);
    expect(sideBySide(['only left'], [], 4)).toEqual(['only left']);
  });

  it('groups dashboards under one header per group', () => {
    expect(
      sidebarItems([
        { title: 'Markets Summary', group: 'Overview' },
        { title: 'Company', group: 'Equities' },
        { title: 'Screeners', group: 'Equities' },
      ]),
    ).toEqual([
      { kind: 'group', label: 'Overview' },
      { kind: 'dashboard', label: 'Markets Summary', index: 0 },
      { kind: 'group', label: 'Equities' },
      { kind: 'dashboard', label: 'Company', index: 1 },
      { kind: 'dashboard', label: 'Screeners', index: 2 },
    ]);
  });

  it('keeps the selection inside the visible window', () => {
    expect(windowStart(3, 10, 5, 0)).toBe(0);
    expect(windowStart(12, 10, 40, 0)).toBe(3);
    expect(windowStart(2, 10, 40, 5)).toBe(2);
    expect(windowStart(39, 10, 40, 0)).toBe(30);
  });

  it('cycles ranges in both directions', () => {
    const r = ['1M', '3M', '1Y'];
    expect(cycle(r, '3M', 1)).toBe('1Y');
    expect(cycle(r, '1Y', 1)).toBe('1M');
    expect(cycle(r, '1M', -1)).toBe('1Y');
    expect(cycle(r, 'nope', 1)).toBe('1M');
  });
});

describe('ResearchStore', () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'b1dz-research-test-'));
    file = join(dir, 'nested', 'research.json');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('starts with a default watchlist and writes a private file', () => {
    const store = new ResearchStore(file);
    expect(store.watchlist()).toEqual(DEFAULT_WATCHLIST);
    store.setKey('FRED', 'abc');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(new ResearchStore(file).state.keys.FRED).toBe('abc');
    store.setKey('FRED', undefined);
    expect(new ResearchStore(file).state.keys.FRED).toBeUndefined();
  });

  it('edits watchlists: add, remove, create and switch', () => {
    const store = new ResearchStore(file);
    expect(store.editWatchlist('+tsla -AAPL +TSLA')).toBe('Main: added TSLA, removed AAPL, added TSLA');
    expect(store.watchlist()).not.toContain('AAPL');
    expect(store.watchlist().filter((s) => s === 'TSLA')).toHaveLength(1);
    expect(store.editWatchlist('-ZZZZ')).toBe('Main: ZZZZ was not on the list');
    expect(store.editWatchlist('Rates +TLT,+IEF')).toBe('Rates: created Rates, added TLT, added IEF');
    expect(store.watchlist()).toEqual(['TLT', 'IEF']);
    expect(store.editWatchlist('main')).toBe('Main: switched to Main');
    expect(store.editWatchlist('  ')).toBe('nothing changed');
    const again = new ResearchStore(file);
    expect(again.state.activeWatchlist).toBe('Main');
    expect(again.state.watchlists.Rates).toEqual(['TLT', 'IEF']);
  });

  it('remembers params per dashboard and pinned cards', () => {
    const store = new ResearchStore(file);
    store.setParam('company', 'symbol', 'NVDA');
    store.pin({ id: 'rates.us-curve', params: { country: 'US' } });
    store.pin({ id: 'overview.chart', params: { symbol: 'SPY' } });
    store.unpin(0);
    const again = new ResearchStore(file);
    expect(again.state.params.company).toEqual({ symbol: 'NVDA' });
    expect(again.state.pinned).toEqual([{ id: 'overview.chart', params: { symbol: 'SPY' } }]);
  });

  it('survives a corrupt file and keeps a copy of it', () => {
    new ResearchStore(file).save();
    writeFileSync(file, '{ not json');
    const store = new ResearchStore(file);
    expect(store.watchlist()).toEqual(DEFAULT_WATCHLIST);
    expect(readFileSync(`${file}.corrupt`, 'utf8')).toBe('{ not json');
  });

  it('falls back to an existing list when the active one is gone', () => {
    new ResearchStore(file).save();
    writeFileSync(file, JSON.stringify({ watchlists: { Tech: ['NVDA'] }, activeWatchlist: 'Gone' }));
    const store = new ResearchStore(file);
    expect(store.state.activeWatchlist).toBe('Tech');
    expect(store.watchlist()).toEqual(['NVDA']);
  });
});
