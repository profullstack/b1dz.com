/**
 * Market research for the HTTP API and the MCP server.
 *
 * The cards are the same ones `b1dz research` shows in the terminal
 * (@b1dz/research). One process-wide context means one response cache, so a
 * popular card is fetched from its public source once per TTL, not per caller.
 */
import {
  MissingKeyError,
  cardToCsv,
  createContext,
  registry,
  renderCard,
  type CardRun,
  type Ctx,
  type SearchHit,
} from '@b1dz/research';

let shared: Ctx | undefined;
function ctx(): Ctx {
  // Optional provider keys come from the environment (FRED_API_KEY, EIA_API_KEY, BLS_API_KEY, CONGRESS_API_KEY).
  return (shared ??= createContext());
}

export interface ApiResult<T> {
  status: number;
  body: T | { error: string; needsKey?: string };
}

/** Dashboards with their tabs, and every card with its params. `query` narrows cards by id or title. */
export function researchCatalog(query?: string) {
  const { dashboards, cards } = registry().catalog();
  const q = query?.trim().toLowerCase();
  const kept = q ? cards.filter((c) => c.id.includes(q) || c.title.toLowerCase().includes(q) || c.description?.toLowerCase().includes(q)) : cards;
  return { dashboards: q ? dashboards.filter((d) => d.tabs.some((t) => t.cards.some((id) => kept.some((c) => c.id === id)))) : dashboards, cards: kept };
}

function cleanParams(given: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(given)) {
    if (typeof v === 'string' || typeof v === 'number') out[k] = String(v).slice(0, 400);
  }
  return out;
}

export async function runResearchCard(id: string, given: Record<string, unknown> = {}): Promise<ApiResult<CardRun>> {
  const reg = registry();
  if (!reg.card(id)) return { status: 404, body: { error: `unknown card: ${id}. List them with GET /api/research` } };
  try {
    return { status: 200, body: await reg.run(ctx(), id, cleanParams(given)) };
  } catch (e) {
    if (e instanceof MissingKeyError) return { status: 424, body: { error: e.message, needsKey: e.keyName } };
    // The source failed, not the caller: 502 with the source's own words.
    return { status: 502, body: { error: (e as Error).message } };
  }
}

export async function researchSearch(query: string): Promise<SearchHit[]> {
  return registry().search(ctx(), query.slice(0, 200), 25);
}

/** A card as plain text: title, source line, tables and charts as a terminal would draw them. */
export function cardAsText(run: CardRun, width = 110, maxRows = 60): string {
  const ps = Object.entries(run.params).map(([k, v]) => `${k}=${v}`).join(' ');
  const head = `${run.title}${ps ? `  ${ps}` : ''}\nSource: ${run.source}${run.asOf ? `, as of ${run.asOf}` : ''}${run.sourceUrl ? `  ${run.sourceUrl}` : ''}`;
  return `${head}\n${renderCard(run, { width, color: 'none', maxRows, chartHeight: 10 }).join('\n')}`;
}

export function cardAsCsv(run: CardRun): string {
  return cardToCsv(run.title, run.source, run);
}
