/**
 * Saved strategies from the /store/build wizard (public.user_strategies).
 *
 * The TSP document is the source of truth: slug, name, description and asset
 * classes are copied out of it into columns so lists and the store can render
 * without parsing JSON. Everything a client sends is validated + compiled here
 * before it reaches the database.
 */
import { tsp } from '@b1dz/source-strategies';
import type { BacktestResponse } from '@/lib/strategy-backtest-runner';

export type Visibility = 'private' | 'published';

/**
 * A strategy switched on for live trading is a user_installed_plugins row with
 * this plugin_id prefix + the user_strategies id; the daemon (apps/daemon
 * src/user-strategies.ts) loads and runs those.
 */
export const TSP_PLUGIN_PREFIX = 'tsp:';
export const runPluginId = (strategyId: string) => `${TSP_PLUGIN_PREFIX}${strategyId}`;

export interface UserStrategyRow {
  id: string;
  user_id: string;
  slug: string;
  name: string;
  description: string;
  definition: Record<string, unknown>;
  asset_classes: string[];
  visibility: Visibility;
  author_name: string | null;
  backtest: BacktestResponse | null;
  backtested_at: string | null;
  published_at: string | null;
  forked_from: string | null;
  created_at: string;
  updated_at: string;
}

/** Columns safe to show anyone (published listings never expose user_id). */
export const PUBLIC_COLUMNS =
  'id, slug, name, description, definition, asset_classes, visibility, author_name, backtest, backtested_at, published_at, forked_from, created_at, updated_at';
export const OWNER_COLUMNS = `${PUBLIC_COLUMNS}, user_id`;

export interface StrategyFields {
  slug: string;
  name: string;
  description: string;
  definition: Record<string, unknown>;
  asset_classes: string[];
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export type ParseResult = { ok: true; fields: StrategyFields } | { ok: false; errors: string[] };

/** Validate + compile a TSP document and derive the row's columns from it. */
export function strategyFieldsFromDefinition(definition: unknown): ParseResult {
  const validation = tsp.validateDefinition(definition);
  if (!validation.ok) return { ok: false, errors: validation.errors };
  try {
    tsp.compile(definition);
  } catch (e) {
    return { ok: false, errors: [(e as Error).message] };
  }
  const doc = definition as Record<string, unknown>;
  const slug = String(doc.id ?? '').trim().toLowerCase();
  const name = String(doc.name ?? '').trim();
  const errors: string[] = [];
  if (!SLUG_RE.test(slug)) errors.push('id must be 1-64 lowercase letters, digits or dashes');
  if (!name || name.length > 120) errors.push('name must be 1-120 characters');
  const description = typeof doc.description === 'string' ? doc.description.trim() : '';
  if (description.length > 1000) errors.push('description must be at most 1000 characters');
  if (errors.length) return { ok: false, errors };
  const asset_classes = Array.isArray(doc.assetClasses)
    ? doc.assetClasses.filter((c): c is string => c === 'crypto' || c === 'equity')
    : [];
  return { ok: true, fields: { slug, name, description, definition: doc, asset_classes } };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Guards route params before they reach Postgres (a bad uuid is a 404, not a 500). */
export function isUuid(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE.test(v);
}

/** Postgres unique_violation on (user_id, slug). */
export function isDuplicateSlug(err: { code?: string } | null | undefined): boolean {
  return err?.code === '23505';
}

/** "Ada L." from a profile, else "b1dz user" — never the email. */
export function authorDisplayName(profile: { first_name?: string | null; last_name?: string | null } | null): string {
  const first = profile?.first_name?.trim();
  if (!first) return 'b1dz user';
  const last = profile?.last_name?.trim();
  return last ? `${first} ${last[0]!.toUpperCase()}.` : first;
}
