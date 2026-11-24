/** The card registry: every surface (TUI, CLI, API, MCP) goes through here. */
import { Http } from './http.js';
import {
  MissingKeyError,
  type AreaModule,
  type CardDef,
  type CardResult,
  type Ctx,
  type DashboardDef,
  type KeyName,
  type SearchHit,
  type SearchProvider,
} from './types.js';

export const KEY_NAMES: KeyName[] = ['FRED', 'EIA', 'BLS', 'CONGRESS'];

export const KEY_INFO: Record<KeyName, { env: string; adds: string; signup: string }> = {
  FRED: {
    env: 'FRED_API_KEY',
    adds: 'Full U.S. macro history, ICE BofA credit spreads, commodity spot prices',
    signup: 'https://fredaccount.stlouisfed.org/apikeys',
  },
  EIA: {
    env: 'EIA_API_KEY',
    adds: 'U.S. crude, product and natural gas inventories, LNG exports, grid data, STEO forecasts',
    signup: 'https://www.eia.gov/opendata/register.php',
  },
  BLS: {
    env: 'BLS_API_KEY',
    adds: 'Higher limits and longer history for CPI, PPI, payrolls and JOLTS tables',
    signup: 'https://data.bls.gov/registrationEngine/',
  },
  CONGRESS: {
    env: 'CONGRESS_API_KEY',
    adds: 'U.S. House and Senate bills, votes, amendments, members and committees',
    signup: 'https://api.congress.gov/sign-up/',
  },
};

export interface ContextOptions {
  http?: Http;
  /** Keys from the user's config; environment variables are the fallback. */
  keys?: Partial<Record<KeyName, string>>;
  env?: Record<string, string | undefined>;
  now?: () => Date;
}

export function createContext(opts: ContextOptions = {}): Ctx {
  const env = opts.env ?? (typeof process !== 'undefined' ? process.env : {});
  const http = opts.http ?? new Http();
  return {
    http,
    key: (name) => opts.keys?.[name] || env[KEY_INFO[name].env] || undefined,
    now: opts.now ?? (() => new Date()),
  };
}

/** A card run, with everything a renderer or an agent needs to label it. */
export interface CardRun extends CardResult {
  id: string;
  title: string;
  source: string;
  params: Record<string, string>;
}

export interface CatalogCard {
  id: string;
  title: string;
  source: string;
  description?: string;
  needsKey?: KeyName;
  params: { name: string; label: string; default?: string; choices?: string[]; hint?: string }[];
}

export class Registry {
  readonly dashboards: DashboardDef[] = [];
  private readonly cards = new Map<string, CardDef>();
  private readonly searchers: SearchProvider[] = [];

  constructor(modules: AreaModule[] = []) {
    for (const m of modules) this.add(m);
  }

  add(m: AreaModule): void {
    for (const c of m.cards) {
      if (this.cards.has(c.id)) throw new Error(`duplicate card id: ${c.id}`);
      this.cards.set(c.id, c);
    }
    for (const d of m.dashboards) {
      if (this.dashboards.some((x) => x.id === d.id)) throw new Error(`duplicate dashboard id: ${d.id}`);
      this.dashboards.push(d);
    }
    if (m.search) this.searchers.push(m.search);
  }

  card(id: string): CardDef | undefined {
    return this.cards.get(id);
  }

  allCards(): CardDef[] {
    return [...this.cards.values()];
  }

  dashboard(id: string): DashboardDef | undefined {
    return this.dashboards.find((d) => d.id === id);
  }

  /** Card ids that a dashboard references but no module defines. Empty in a healthy build. */
  danglingCards(): string[] {
    const out: string[] = [];
    for (const d of this.dashboards) for (const t of d.tabs) for (const c of t.cards) if (!this.cards.has(c)) out.push(`${d.id}/${t.id}: ${c}`);
    return out;
  }

  /** Params with the card's defaults filled in; unknown names are dropped. */
  resolveParams(card: CardDef, given: Record<string, string | undefined> = {}): Record<string, string> {
    const out: Record<string, string> = {};
    for (const p of card.params ?? []) {
      const v = given[p.name];
      const value = typeof v === 'string' && v.trim() !== '' ? v.trim() : p.default;
      if (value !== undefined) out[p.name] = value;
    }
    return out;
  }

  async run(ctx: Ctx, id: string, given: Record<string, string | undefined> = {}): Promise<CardRun> {
    const card = this.cards.get(id);
    if (!card) throw new Error(`unknown card: ${id}`);
    if (card.needsKey && !ctx.key(card.needsKey)) throw new MissingKeyError(card.needsKey);
    const params = this.resolveParams(card, given);
    const result = await card.run(ctx, params);
    return { ...result, id: card.id, title: card.title, source: result.source ?? card.source, params };
  }

  catalog(): { dashboards: DashboardDef[]; cards: CatalogCard[] } {
    return {
      dashboards: this.dashboards,
      cards: this.allCards().map((c) => ({
        id: c.id,
        title: c.title,
        source: c.source,
        description: c.description,
        needsKey: c.needsKey,
        params: (c.params ?? []).map((p) => ({ name: p.name, label: p.label, default: p.default, choices: p.choices, hint: p.hint })),
      })),
    };
  }

  /** Dashboards and cards by name, then whatever the area modules find (tickers, datasets). */
  async search(ctx: Ctx, query: string, limit = 20): Promise<SearchHit[]> {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const local: SearchHit[] = [];
    for (const d of this.dashboards) {
      if (d.title.toLowerCase().includes(q) || d.id.includes(q)) {
        local.push({ kind: 'dashboard', label: d.title, detail: d.group, dashboard: d.id });
      }
      for (const t of d.tabs) {
        if (t.title.toLowerCase().includes(q)) {
          local.push({ kind: 'dashboard', label: `${d.title} > ${t.title}`, detail: d.group, dashboard: d.id, tab: t.id });
        }
        for (const id of t.cards) {
          const c = this.cards.get(id);
          if (c && (c.title.toLowerCase().includes(q) || c.id.includes(q) || c.description?.toLowerCase().includes(q))) {
            local.push({ kind: 'card', label: c.title, detail: `${d.title} > ${t.title}`, dashboard: d.id, tab: t.id });
          }
        }
      }
    }
    const remote = await Promise.all(this.searchers.map((s) => s(ctx, query).catch(() => [] as SearchHit[])));
    const seen = new Set<string>();
    const out: SearchHit[] = [];
    // Securities and datasets first: someone typing "aapl" wants Apple, not a card with "aapl" in its id.
    for (const h of [...remote.flat(), ...local]) {
      const k = `${h.kind}|${h.label}|${h.dashboard}|${h.tab ?? ''}|${JSON.stringify(h.params ?? {})}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(h);
      if (out.length >= limit) break;
    }
    return out;
  }
}
