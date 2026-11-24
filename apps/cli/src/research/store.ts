/**
 * Local state for `b1dz research`: optional API keys, watchlists, the last
 * params used on each dashboard, and the user's own dashboard.
 *
 * Lives at ~/.config/b1dz/research.json (mode 600). Nothing here is sent to
 * b1dz.com; keys go only to the provider they belong to.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { KeyName } from '@b1dz/research';

export interface PinnedCard {
  id: string;
  params: Record<string, string>;
}

export interface ResearchState {
  keys: Partial<Record<KeyName, string>>;
  watchlists: Record<string, string[]>;
  activeWatchlist: string;
  /** Last params per dashboard id. */
  params: Record<string, Record<string, string>>;
  /** Cards pinned to "My dashboard", with the params they were pinned with. */
  pinned: PinnedCard[];
  last?: { dashboard: string; tab: string };
}

export const DEFAULT_WATCHLIST = ['AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'SPY', 'QQQ', 'BTC-USD'];

export function defaultState(): ResearchState {
  return { keys: {}, watchlists: { Main: [...DEFAULT_WATCHLIST] }, activeWatchlist: 'Main', params: {}, pinned: [] };
}

export function storePath(): string {
  return process.env.B1DZ_RESEARCH_FILE ?? join(homedir(), '.config', 'b1dz', 'research.json');
}

export class ResearchStore {
  state: ResearchState;

  constructor(private readonly path: string = storePath()) {
    this.state = this.read();
  }

  private read(): ResearchState {
    const base = defaultState();
    if (!existsSync(this.path)) return base;
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<ResearchState>;
      const watchlists = raw.watchlists && Object.keys(raw.watchlists).length ? raw.watchlists : base.watchlists;
      return {
        keys: raw.keys ?? {},
        watchlists,
        activeWatchlist: raw.activeWatchlist && watchlists[raw.activeWatchlist] ? raw.activeWatchlist : Object.keys(watchlists)[0],
        params: raw.params ?? {},
        pinned: Array.isArray(raw.pinned) ? raw.pinned : [],
        last: raw.last,
      };
    } catch {
      // A corrupt file must not lock the user out; start fresh and keep the bad file for inspection.
      try {
        writeFileSync(`${this.path}.corrupt`, readFileSync(this.path));
      } catch {
        /* best effort */
      }
      return base;
    }
  }

  save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 });
    try {
      chmodSync(this.path, 0o600);
    } catch {
      /* not every filesystem has modes */
    }
  }

  watchlist(): string[] {
    return this.state.watchlists[this.state.activeWatchlist] ?? [];
  }

  /**
   * Apply a watchlist edit: `+SYM` adds, `-SYM` removes, a bare name switches
   * to (or creates) the list with that name. Returns a line describing what changed.
   */
  editWatchlist(input: string): string {
    const tokens = input.split(/[\s,]+/).filter(Boolean);
    const done: string[] = [];
    for (const tok of tokens) {
      if (tok.startsWith('+') || tok.startsWith('-')) {
        const sym = tok.slice(1).toUpperCase();
        if (!sym) continue;
        const list = (this.state.watchlists[this.state.activeWatchlist] ??= []);
        const at = list.indexOf(sym);
        if (tok.startsWith('+')) {
          if (at < 0) list.push(sym);
          done.push(`added ${sym}`);
        } else {
          if (at >= 0) list.splice(at, 1);
          done.push(at >= 0 ? `removed ${sym}` : `${sym} was not on the list`);
        }
      } else {
        const existing = Object.keys(this.state.watchlists).find((n) => n.toLowerCase() === tok.toLowerCase());
        const name = existing ?? tok;
        this.state.watchlists[name] ??= [];
        this.state.activeWatchlist = name;
        done.push(existing ? `switched to ${name}` : `created ${name}`);
      }
    }
    if (done.length) this.save();
    return done.length ? `${this.state.activeWatchlist}: ${done.join(', ')}` : 'nothing changed';
  }

  setKey(name: KeyName, value: string | undefined): void {
    if (value) this.state.keys[name] = value;
    else delete this.state.keys[name];
    this.save();
  }

  setParam(dashboard: string, name: string, value: string): void {
    (this.state.params[dashboard] ??= {})[name] = value;
    this.save();
  }

  pin(card: PinnedCard): void {
    this.state.pinned.push(card);
    this.save();
  }

  unpin(index: number): void {
    this.state.pinned.splice(index, 1);
    this.save();
  }
}
