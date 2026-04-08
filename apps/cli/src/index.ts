#!/usr/bin/env node
/**
 * b1dz CLI dispatcher.
 *
 * Usage:
 *   b1dz                          # show help
 *   b1dz dealdash tui             # ink TUI for dealdash (lifted from ~/src/dealdash)
 *   b1dz dealdash run             # headless dealdash daemon
 *   b1dz crypto-arb run           # cross-exchange arbitrage scanner
 *   b1dz crypto-trade run         # single-exchange day-trading daemon
 *   b1dz all                      # run every registered source headless
 *   b1dz alerts                   # tail the alert bus
 *
 * Each subcommand boots the runner with a subset of sources and (optionally)
 * a renderer. The headless `run` modes share one shared Storage + AlertBus,
 * so the web dashboard can read from the same JSON files in parallel.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRootEnv, Runner, AlertBus, type Source, type Storage } from '@b1dz/core';
loadRootEnv();
import { JsonStorage } from '@b1dz/storage-json';
import { SupabaseStorage } from '@b1dz/storage-supabase';
import { B1dzApiStorage } from '@b1dz/storage-b1dz-api';
import { createClient } from '@supabase/supabase-js';
import { loadCredentials, getApiClient } from './auth.js';
import { dealDashSource } from '@b1dz/source-dealdash';
import { cryptoArbSource } from '@b1dz/source-crypto-arb';
import { cryptoTradeSource } from '@b1dz/source-crypto-trade';
import { signup, login, logout, whoami, currentUser, promptPassword } from './auth.js';
import { parseDealDashCookie, saveDealDashCreds, loadDealDashCreds, buildCookieHeader } from './dealdash/credentials.js';
import { autoLoginDealDash } from './dealdash/auto-login.js';
import { hydrateAll as hydrateDealDashState, startBackgroundFlush as startDealDashStateFlush } from './dealdash/state-sync.js';
import { createInterface } from 'node:readline/promises';

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(here, '../../../data');

// ----- registry: name → list of sources for that subcommand -----
const SOURCE_REGISTRY: Record<string, Source[]> = {
  dealdash: [dealDashSource],
  'crypto-arb': [cryptoArbSource],
  'crypto-trade': [cryptoTradeSource],
  all: [dealDashSource, cryptoArbSource, cryptoTradeSource],
};

function makeStorage(): Storage {
  // STORAGE=json forces local files (offline dev).
  // STORAGE=supabase uses the direct Supabase adapter (legacy / local trusted host).
  // Default = b1dz API adapter — talks to b1dz.com (or B1DZ_API_URL) with the
  // signed-in user's bearer token. RLS enforced. No secret key needed.
  if (process.env.STORAGE === 'json') return new JsonStorage(dataDir);
  if (process.env.STORAGE === 'supabase') {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SECRET_KEY || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
    if (url && key) return new SupabaseStorage({ url, key, userId: process.env.B1DZ_USER_ID });
  }
  if (process.env.B1DZ_API_URL && loadCredentials()) {
    return getApiClient();
  }
  console.warn('No b1dz API URL or credentials — falling back to JsonStorage in', dataDir);
  return new JsonStorage(dataDir);
}

/** Append a log line to the `logs` table in Supabase (best effort). */
function makeDbLogger() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) return null;
  const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  return (row: { source_id?: string | null; level: string; message: string; context?: unknown }) => {
    void client.from('logs').insert(row).then((res: { error: { message: string } | null }) => {
      if (res.error) console.error('db log insert failed:', res.error.message);
    });
  };
}

function makeRuntime() {
  const storage = makeStorage();
  const alerts = new AlertBus();
  const dbLog = makeDbLogger();
  alerts.subscribe((a) => {
    const color = a.level === 'good' ? '\x1b[32m' : a.level === 'bad' ? '\x1b[31m' : a.level === 'warn' ? '\x1b[33m' : '\x1b[36m';
    console.log(`${color}[${a.sourceId}] ${a.text}\x1b[0m`);
    dbLog?.({
      source_id: a.sourceId,
      level: a.level === 'good' ? 'info' : a.level === 'bad' ? 'error' : a.level === 'warn' ? 'warn' : 'info',
      message: a.text,
      context: { opportunityId: a.opportunityId, link: a.link },
    });
  });
  return { storage, alerts, dbLog };
}

function help() {
  console.log(`b1dz — multi-source profit monitor

Auth:
  b1dz signup           create an account (email + password)
  b1dz login            sign in to an existing account
  b1dz logout           clear local credentials
  b1dz whoami           show current user

Sources:
  b1dz <source> run        start headless
  b1dz dealdash connect    paste your DealDash cookies (manual)
  b1dz dealdash login      automated DealDash login via browserless+capsolver
  b1dz dealdash tui        launch the ink TUI

  Available sources: dealdash, crypto-arb, crypto-trade, all

Other:
  b1dz alerts           tail the alert bus
  b1dz help             this message
`);
}

function requireAuth() {
  const u = currentUser();
  if (!u) {
    console.error('not signed in — run `b1dz signup` or `b1dz login` first');
    process.exit(1);
  }
  // Expose to downstream code via env so the storage adapter can stamp writes
  process.env.B1DZ_USER_ID = u.userId;
  return u;
}

async function runHeadless(sources: Source[]) {
  const { storage, alerts } = makeRuntime();
  const runner = new Runner({ sources, storage, alerts });
  await runner.start();
  console.log(`b1dz running ${sources.length} source(s). Ctrl+C to quit.`);
  process.on('SIGINT', () => { void runner.stop().then(() => process.exit(0)); });
}

async function runDealDashTui() {
  await ensureDealDashCookie();
  // The TUI module has top-level side effects (render + console patching),
  // so we just import it dynamically — that boots the whole interface.
  await import('./tui/dealdash.js');
}

/** Pull DealDash creds from the DB and inject into env so the vendored
 *  api.ts (which reads process.env.DEALDASH_COOKIE) keeps working unchanged.
 *  Also hydrate every persistent cache from `source_state.payload.caches` and
 *  start the background flush timer. */
async function ensureDealDashCookie() {
  const userId = process.env.B1DZ_USER_ID;
  if (!userId) return;
  const creds = await loadDealDashCreds(userId);
  if (!creds) {
    console.error('No DealDash session saved — run `b1dz dealdash login` (auto) or `b1dz dealdash connect` (paste).');
    process.exit(1);
  }
  process.env.DEALDASH_COOKIE = buildCookieHeader(creds);
  // The TUI module hydrates its caches from Supabase on its own startup
  // (using B1DZ_USER_ID, which requireAuth() already set in env).
}

/** Interactive automated login — uses browserless + capsolver to log in
 *  to DealDash with your real credentials and save the resulting cookies. */
async function dealDashLogin() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const email = (await rl.question('DealDash email: ')).trim();
  rl.close();
  const password = await promptPassword('DealDash password: ');
  const userId = process.env.B1DZ_USER_ID!;
  await autoLoginDealDash({ userId, email, password });
}

/** Interactive paste-the-cookie flow. */
async function dealDashConnect() {
  console.log('Paste your DealDash cookies (any of these formats works):');
  console.log('  - "PHPSESSID=...; REMEMBERME=..."');
  console.log('  - the "Cookie:" header from a cURL export');
  console.log('  - the JSON blob from DevTools → Storage → Cookies');
  console.log('Finish with a blank line.\n');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const lines: string[] = [];
  for await (const line of rl) {
    if (line.trim() === '') break;
    lines.push(line);
  }
  rl.close();
  const raw = lines.join(' ');
  const creds = parseDealDashCookie(raw);
  if (!creds) {
    console.error('Could not find PHPSESSID and REMEMBERME in your input.');
    process.exit(1);
  }
  const userId = process.env.B1DZ_USER_ID!;
  await saveDealDashCreds(userId, creds);
  console.log('✓ DealDash session saved.');
  console.log(`  PHPSESSID:  ${creds.phpsessid.slice(0, 8)}…`);
  console.log(`  REMEMBERME: ${creds.rememberme.slice(0, 12)}…`);
}

async function tailAlerts() {
  const { alerts } = makeRuntime();
  console.log('Tailing alerts. Ctrl+C to quit.');
  // makeRuntime() already subscribed a printer; just keep the process alive
  await new Promise(() => {});
  void alerts;
}

const [, , source, sub] = process.argv;

if (!source || source === 'help' || source === '--help' || source === '-h') {
  help();
  process.exit(0);
}

// Auth commands run before requireAuth so unauthenticated users can sign up
if (source === 'signup') { await signup(); process.exit(0); }
if (source === 'login') { await login(); process.exit(0); }
if (source === 'logout') { logout(); process.exit(0); }
if (source === 'whoami') { whoami(); process.exit(0); }

// Everything else requires a signed-in user
requireAuth();

if (source === 'alerts') {
  await tailAlerts();
} else if (source === 'all') {
  await runHeadless(SOURCE_REGISTRY.all);
} else if (SOURCE_REGISTRY[source]) {
  if (sub === 'tui' && source === 'dealdash') {
    await runDealDashTui();
  } else if (sub === 'connect' && source === 'dealdash') {
    await dealDashConnect();
  } else if (sub === 'login' && source === 'dealdash') {
    await dealDashLogin();
  } else if (sub === 'run' || !sub) {
    if (source === 'dealdash' || source === 'all') await ensureDealDashCookie();
    await runHeadless(SOURCE_REGISTRY[source]);
  } else {
    console.error(`unknown subcommand: ${sub}`);
    help();
    process.exit(1);
  }
} else {
  console.error(`unknown source: ${source}`);
  help();
  process.exit(1);
}
