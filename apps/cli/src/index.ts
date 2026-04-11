#!/usr/bin/env node
/**
 * b1dz CLI dispatcher.
 *
 * Usage:
 *   b1dz                          # show help
 *   b1dz crypto-arb run           # cross-exchange arbitrage scanner
 *   b1dz crypto-trade run         # single-exchange day-trading daemon
 *   b1dz all                      # run every registered source headless
 *   b1dz alerts                   # tail the alert bus
 *
 * Each subcommand boots the runner with a subset of sources. The headless
 * `run` modes share one shared Storage + AlertBus, so the web dashboard
 * can read from the same JSON files in parallel.
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
import { cryptoArbSource } from '@b1dz/source-crypto-arb';
import { cryptoTradeSource } from '@b1dz/source-crypto-trade';
import { signup, login, logout, whoami, currentUser } from './auth.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(here, '../../../data');

// ----- registry: name → list of sources for that subcommand -----
const SOURCE_REGISTRY: Record<string, Source[]> = {
  'crypto-arb': [cryptoArbSource],
  'crypto-trade': [cryptoTradeSource],
  all: [cryptoArbSource, cryptoTradeSource],
};

function makeStorage(): Storage {
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

Dashboard:
  b1dz tui                 live crypto dashboard

Sources:
  b1dz <source> run        start headless
  Available sources: crypto-arb, crypto-trade, all

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

async function tailAlerts() {
  const { alerts } = makeRuntime();
  console.log('Tailing alerts. Ctrl+C to quit.');
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

if (source === 'tui') {
  const { startTui } = await import('./tui/index.js');
  startTui();
} else if (source === 'alerts') {
  await tailAlerts();
} else if (source === 'all') {
  await runHeadless(SOURCE_REGISTRY.all);
} else if (SOURCE_REGISTRY[source]) {
  if (sub === 'run' || !sub) {
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
