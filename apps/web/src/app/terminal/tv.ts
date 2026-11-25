/**
 * Pure logic for the terminal's live TV tile: which channels it offers, how a
 * match from hdtilt.com becomes something the player can load, and the cache
 * of found channels. No React and no DOM, so all of it is unit tested.
 */

import { TV_CHANNELS, type TvChannel } from '@b1dz/core/terminal';

export { TV_CHANNELS, type TvChannel };

/** One playable channel as hdtilt's /api/tv/find returns it. */
export interface TvMatch {
  id: string;
  name: string;
  group?: string;
  playlist?: string;
  logo?: string;
  play: { kind: 'hls' | 'mpegts'; src: string; hls?: string };
}

export interface TvFindReply {
  playlists?: number;
  results?: { q: string; matches: TvMatch[] }[];
}

/** channel key -> its best match (absent when the library has no such channel). */
export type TvLineup = Record<string, TvMatch>;

/** Map hdtilt's answer back onto our channel keys, taking the first (best) match of each. */
export function lineupFrom(reply: TvFindReply, channels: TvChannel[] = TV_CHANNELS): TvLineup {
  const out: TvLineup = {};
  for (const ch of channels) {
    const hit = reply.results?.find((r) => r.q === ch.query)?.matches?.[0];
    if (hit?.play?.src) out[ch.key] = hit;
  }
  return out;
}

export interface TvSource {
  src: string;
  kind: 'hls' | 'mpegts';
}

/**
 * What to hand the player. A raw transport stream needs Media Source
 * Extensions; without them (older iPhones) the same channel is asked for as
 * HLS, which hdtilt converts. Paths from hdtilt are relative to its site.
 */
export function sourceFor(match: TvMatch, site: string, canMse: boolean): TvSource {
  const abs = (p: string) => (/^https?:\/\//i.test(p) ? p : `${site.replace(/\/+$/, '')}${p}`);
  if (match.play.kind === 'mpegts' && !canMse && match.play.hls) return { src: abs(match.play.hls), kind: 'hls' };
  return { src: abs(match.play.src), kind: match.play.kind };
}

// ---- cache: found once, reused until it stops working ----------------------

export const TV_CACHE_KEY = 'b1dz:terminal:tv:lineup';
/** Providers reshuffle stream ids now and then; look channels up again weekly. */
export const TV_CACHE_TTL_MS = 7 * 86_400_000;

export interface TvCache {
  at: number;
  site: string;
  lineup: TvLineup;
}

/** A cached lineup that is still usable, or null. */
export function readTvCache(raw: string | null, site: string, now: number): TvLineup | null {
  if (!raw) return null;
  try {
    const c = JSON.parse(raw) as Partial<TvCache>;
    if (c.site !== site || typeof c.at !== 'number' || now - c.at > TV_CACHE_TTL_MS || !c.lineup || typeof c.lineup !== 'object') return null;
    const lineup: TvLineup = {};
    for (const [k, m] of Object.entries(c.lineup)) if (m?.play?.src && (m.play.kind === 'hls' || m.play.kind === 'mpegts')) lineup[k] = m;
    return Object.keys(lineup).length ? lineup : null;
  } catch {
    return null;
  }
}

export function writeTvCache(lineup: TvLineup, site: string, now: number): string {
  return JSON.stringify({ at: now, site, lineup } satisfies TvCache);
}

/** What to tell the viewer when hdtilt will not list channels. */
export function findProblem(status: number, code: string | undefined, site: string): { text: string; href?: string; action?: string } {
  const host = site.replace(/^https?:\/\//, '');
  if (status === 423) return { text: `Your ${host} library is locked. Unlock it there with your passphrase, then try again.`, href: site, action: `open ${host}` };
  if (status === 404 || code === 'no_playlist') return { text: `There is no playlist in your ${host} account yet. Add your IPTV playlist there first.`, href: site, action: `open ${host}` };
  if (status === 401) return { text: `The ${host} connection ended. Connect again.` };
  if (status === 429) return { text: `${host} is busy (too many requests). Try again in a minute.` };
  return { text: `${host} could not list your channels (HTTP ${status}). Try again shortly.` };
}

/** The next channel in button order that the lineup actually has. */
export function nextChannel(current: string | null, lineup: TvLineup, step: 1 | -1 = 1, channels: TvChannel[] = TV_CHANNELS): string | null {
  const have = channels.filter((c) => lineup[c.key]);
  if (!have.length) return null;
  const at = have.findIndex((c) => c.key === current);
  return have[(at + step + have.length) % have.length].key;
}
