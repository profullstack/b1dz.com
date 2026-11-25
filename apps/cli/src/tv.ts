/**
 * `b1dz tv`: CNBC, Bloomberg and Fox Business from your own hdtilt.com
 * playlists, played in mpv.
 *
 *   b1dz tv                 the three channels and what each matched in your playlists
 *   b1dz tv login           connect your hdtilt.com account (opens the browser)
 *   b1dz tv watch <name>    play one: cnbc, bloomberg (bbg) or fox
 *   b1dz tv url <name>      print the stream address instead of playing it
 *   b1dz tv logout          disconnect
 *
 * Sign-in is OAuth 2.1 with PKCE and a loopback redirect (public client
 * `b1dz-cli`): no password is typed here and there is no client secret.
 * Tokens live in ~/.config/b1dz/tv.json (mode 600). hdtilt finds the channels
 * by name in your playlists (/api/tv/find), so this program never holds your
 * playlist address; the stream is fetched from hdtilt's proxy with your token.
 * The same service feeds the TV tile at https://b1dz.com/terminal.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { TV_CHANNELS, tvChannelOf, type TvChannel } from '@b1dz/core';

export const TV_CLI_CLIENT = 'b1dz-cli';
const UA = 'b1dz-cli-tv/1';

export const TV_USAGE = `b1dz tv: live business TV from your hdtilt.com playlists

  b1dz tv                 the channels and what each matched in your playlists
  b1dz tv login           connect your hdtilt.com account (opens the browser)
  b1dz tv watch <name>    play one in mpv: cnbc, bloomberg (bbg), fox
  b1dz tv url <name>      print the stream address (it needs your token as a header)
  b1dz tv logout          disconnect

hdtilt.com plays an IPTV playlist you already have. Channels come from your
own account; nothing is stored on b1dz.com. In the terminal (b1dz) press v.
In a browser: https://b1dz.com/terminal, then the tv button.`;

export function tvSite(): string {
  return (process.env.HDTILT_URL || 'https://hdtilt.com').replace(/\/+$/, '');
}

export function tvAuthPath(): string {
  return process.env.B1DZ_TV_FILE ?? join(homedir(), '.config', 'b1dz', 'tv.json');
}

interface Saved {
  site: string;
  access_token: string;
  refresh_token: string;
  expires_at: number;
}

function load(): Saved | null {
  try {
    const s = JSON.parse(readFileSync(tvAuthPath(), 'utf8')) as Saved;
    return s.site === tvSite() && s.refresh_token ? s : null;
  } catch {
    return null;
  }
}

function save(s: Saved): void {
  const p = tvAuthPath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, `${JSON.stringify(s, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(p, 0o600);
  } catch {
    /* not every filesystem has modes */
  }
}

async function tokenCall(params: Record<string, string>): Promise<{ ok: boolean; status: number; body: Record<string, unknown> }> {
  try {
    const res = await fetch(`${tvSite()}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', 'user-agent': UA },
      body: new URLSearchParams({ ...params, client_id: TV_CLI_CLIENT }).toString(),
      signal: AbortSignal.timeout(15_000),
    });
    return { ok: res.ok, status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  } catch (e) {
    return { ok: false, status: 0, body: { error: (e as Error).message } };
  }
}

function keep(body: Record<string, unknown>, previousRefresh?: string): Saved {
  const s: Saved = {
    site: tvSite(),
    access_token: String(body.access_token),
    refresh_token: String(body.refresh_token ?? previousRefresh ?? ''),
    expires_at: Date.now() + Math.max(60, Number(body.expires_in) || 3600) * 1000,
  };
  save(s);
  return s;
}

/** The consent URL for a loopback sign-in, and the secrets that go with it. */
export function authorizeRequest(site: string, port: number, random: (n: number) => Buffer = randomBytes) {
  const verifier = random(48).toString('base64url');
  const state = random(16).toString('base64url');
  const redirectUri = `http://127.0.0.1:${port}/callback`;
  const url = new URL(`${site}/oauth/authorize`);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', TV_CLI_CLIENT);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('code_challenge', createHash('sha256').update(verifier).digest('base64url'));
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', state);
  return { url: url.toString(), verifier, state, redirectUri };
}

function openBrowser(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  } catch {
    /* the URL is printed too */
  }
}

/** Connect: a one-shot loopback listener receives the authorization code. */
export async function tvLogin(log: (line: string) => void = console.log): Promise<boolean> {
  const site = tvSite();
  return new Promise((resolve) => {
    let request: ReturnType<typeof authorizeRequest>;
    const server = createServer((req, res) => {
      const u = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (u.pathname !== '/callback') {
        res.writeHead(404);
        return res.end();
      }
      const done = (ok: boolean, text: string) => {
        res.writeHead(ok ? 200 : 400, { 'content-type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><meta charset="utf-8"><title>b1dz tv</title><body style="font:16px system-ui;background:#09090b;color:#e4e4e7;padding:3rem"><h1>${ok ? 'Connected' : 'Not connected'}</h1><p>${text}</p></body>`);
        server.close();
        clearTimeout(timer);
        resolve(ok);
      };
      if (u.searchParams.get('error')) return done(false, 'You declined. Run b1dz tv login to try again.');
      const code = u.searchParams.get('code');
      if (!code || u.searchParams.get('state') !== request.state) return done(false, 'This sign-in link did not match. Run b1dz tv login again.');
      void tokenCall({ grant_type: 'authorization_code', code, redirect_uri: request.redirectUri, code_verifier: request.verifier }).then((r) => {
        if (!r.ok || !r.body.access_token || !r.body.refresh_token) {
          log(`✗ hdtilt did not finish the sign-in (${r.status}${r.body.error ? `: ${String(r.body.error)}` : ''})`);
          return done(false, 'hdtilt did not finish the sign-in. Run b1dz tv login again.');
        }
        keep(r.body);
        log('✓ hdtilt connected. Try: b1dz tv');
        done(true, 'You can close this tab and go back to your terminal.');
      });
    });
    const timer = setTimeout(() => {
      log('✗ no answer within 5 minutes; run b1dz tv login again');
      server.close();
      resolve(false);
    }, 5 * 60_000);
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      request = authorizeRequest(site, port);
      log(`Opening ${site.replace(/^https?:\/\//, '')} to connect your account. If no browser opens, visit:\n\n  ${request.url}\n`);
      openBrowser(request.url);
    });
  });
}

/** A usable access token, refreshed when it is nearly out. null = not connected. */
export async function tvAccessToken(): Promise<string | null> {
  const s = load();
  if (!s) return null;
  if (s.expires_at - Date.now() > 5 * 60_000) return s.access_token;
  const r = await tokenCall({ grant_type: 'refresh_token', refresh_token: s.refresh_token });
  if (r.ok && r.body.access_token) return keep(r.body, s.refresh_token).access_token;
  // The grant is gone at hdtilt: forget it. A network failure is not that.
  if (r.status === 400 || r.status === 401) rmSync(tvAuthPath(), { force: true });
  return null;
}

export async function tvLogout(): Promise<void> {
  const s = load();
  if (s) {
    await fetch(`${tvSite()}/oauth/revoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': UA },
      body: new URLSearchParams({ token: s.refresh_token, client_id: TV_CLI_CLIENT }).toString(),
      signal: AbortSignal.timeout(10_000),
    }).catch(() => {});
  }
  rmSync(tvAuthPath(), { force: true });
}

export interface TvMatch {
  name: string;
  group?: string;
  playlist?: string;
  play: { kind: string; src: string; hls?: string };
}
export type TvFound = { ok: true; lineup: Record<string, TvMatch> } | { ok: false; error: string };

/** What went wrong finding channels, in words that say what to do. */
export function tvFindError(status: number, body: Record<string, unknown>, site: string): string {
  const host = site.replace(/^https?:\/\//, '');
  if (status === 423) return `your ${host} library is locked: open ${site}, unlock it with your passphrase, then try again`;
  if (status === 404) return `there is no playlist in your ${host} account yet: add your IPTV playlist at ${site}`;
  if (status === 401) return 'the hdtilt connection ended: run `b1dz tv login`';
  if (status === 0) return `could not reach ${host}: ${String(body.error ?? 'network error')}`;
  return `${host} could not list your channels (${status}${body.error ? `: ${String(body.error)}` : ''})`;
}

export async function tvFind(token: string): Promise<TvFound> {
  const site = tvSite();
  let res: Response;
  try {
    res = await fetch(`${site}/api/tv/find`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'user-agent': UA },
      body: JSON.stringify({ names: TV_CHANNELS.map((c) => c.query), limit: 1 }),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (e) {
    return { ok: false, error: tvFindError(0, { error: (e as Error).message }, site) };
  }
  const body = (await res.json().catch(() => ({}))) as { results?: { q: string; matches: TvMatch[] }[]; error?: string };
  if (!res.ok) return { ok: false, error: tvFindError(res.status, body, site) };
  const lineup: Record<string, TvMatch> = {};
  for (const c of TV_CHANNELS) {
    const hit = body.results?.find((r) => r.q === c.query)?.matches?.[0];
    if (hit?.play?.src) lineup[c.key] = hit;
  }
  return { ok: true, lineup };
}

/** The address mpv plays (the stream as the provider sends it; mpv decodes transport streams itself). */
export function streamUrl(match: TvMatch, site: string): string {
  return /^https?:\/\//i.test(match.play.src) ? match.play.src : `${site}${match.play.src}`;
}

/** mpv arguments for one channel. The token travels as a request header, never in the address. */
export function mpvArgs(url: string, token: string, title: string): string[] {
  return [`--http-header-fields=Authorization: Bearer ${token}`, `--user-agent=${UA}`, `--title=${title}`, '--force-window=immediate', '--cache=yes', url];
}

export function hasMpv(): boolean {
  const probe = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['mpv'], { stdio: 'ignore' });
  return probe.status === 0;
}

/**
 * Start a channel in mpv, in its own window, and return a line to show. The
 * player is detached, so the terminal (or the TUI) keeps running.
 */
export async function tvWatch(channel: TvChannel, opts: { detached?: boolean } = {}): Promise<{ ok: boolean; message: string }> {
  const token = await tvAccessToken();
  if (!token) return { ok: false, message: 'connect hdtilt first: b1dz tv login' };
  if (!hasMpv()) return { ok: false, message: 'mpv is not installed (https://mpv.io). In a browser, use the tv button at https://b1dz.com/terminal' };
  const found = await tvFind(token);
  if (!found.ok) return { ok: false, message: found.error };
  const match = found.lineup[channel.key];
  if (!match) return { ok: false, message: `${channel.label} is not in your hdtilt playlists` };
  const child = spawn('mpv', mpvArgs(streamUrl(match, tvSite()), token, `${channel.label} · b1dz tv`), { stdio: opts.detached === false ? 'inherit' : 'ignore', detached: opts.detached !== false });
  child.on('error', () => {});
  if (opts.detached !== false) child.unref();
  else await new Promise((r) => child.on('exit', r));
  return { ok: true, message: `${channel.label}: ${match.name} (playing in mpv)` };
}

export async function runTvCli(args: string[]): Promise<number> {
  const [cmd, ...rest] = args.filter((a) => !a.startsWith('--'));
  const json = args.includes('--json');
  if (cmd === 'help' || args.includes('--help') || args.includes('-h')) {
    console.log(TV_USAGE);
    return 0;
  }
  if (cmd === 'login') return (await tvLogin()) ? 0 : 1;
  if (cmd === 'logout') {
    await tvLogout();
    console.log('hdtilt disconnected');
    return 0;
  }
  if (cmd && !['list', 'watch', 'url', 'play'].includes(cmd) && !tvChannelOf(cmd)) {
    console.error(`unknown tv command: ${cmd}\n\n${TV_USAGE}`);
    return 2;
  }

  // `b1dz tv cnbc` is short for `b1dz tv watch cnbc`.
  const action = cmd && tvChannelOf(cmd) ? 'watch' : (cmd ?? 'list');
  const name = cmd && tvChannelOf(cmd) ? cmd : rest[0];

  if (action === 'watch' || action === 'play') {
    const channel = name ? tvChannelOf(name) : undefined;
    if (!channel) {
      console.error(`usage: b1dz tv watch <${TV_CHANNELS.map((c) => c.key).join(' | ')}>`);
      return 2;
    }
    const r = await tvWatch(channel);
    console[r.ok ? 'log' : 'error'](r.ok ? `▶ ${r.message}` : `✗ ${r.message}`);
    return r.ok ? 0 : 1;
  }

  const token = await tvAccessToken();
  if (!token) {
    console.error('✗ hdtilt is not connected: run `b1dz tv login`');
    return 1;
  }
  const found = await tvFind(token);
  if (!found.ok) {
    console.error(`✗ ${found.error}`);
    return 1;
  }
  if (action === 'url') {
    const channel = name ? tvChannelOf(name) : undefined;
    const match = channel && found.lineup[channel.key];
    if (!channel || !match) {
      console.error(channel ? `✗ ${channel.label} is not in your hdtilt playlists` : `usage: b1dz tv url <${TV_CHANNELS.map((c) => c.key).join(' | ')}>`);
      return channel ? 1 : 2;
    }
    console.log(streamUrl(match, tvSite()));
    console.error('(send your token with it: Authorization: Bearer <token from ~/.config/b1dz/tv.json>)');
    return 0;
  }
  if (json) {
    console.log(JSON.stringify(Object.fromEntries(TV_CHANNELS.map((c) => [c.key, found.lineup[c.key] ? { name: found.lineup[c.key].name, group: found.lineup[c.key].group, playlist: found.lineup[c.key].playlist } : null])), null, 2));
    return 0;
  }
  for (const c of TV_CHANNELS) {
    const m = found.lineup[c.key];
    console.log(`${c.label.padEnd(13)} ${m ? `${m.name}${m.group ? `  (${m.group})` : ''}` : 'not in your playlists'}`);
  }
  console.log(`\nWatch one: b1dz tv watch ${TV_CHANNELS[0].key}${hasMpv() ? '' : '   (needs mpv: https://mpv.io)'}`);
  return 0;
}

/** Whether a sign-in is on file (no network). */
export function tvConnected(): boolean {
  return existsSync(tvAuthPath()) && load() !== null;
}
