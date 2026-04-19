#!/usr/bin/env node
/**
 * b1dzd — the b1dz daemon entry point.
 *
 * Runs identically under: a terminal, systemd, Docker, Railway. The only
 * thing that changes between environments is how the process is supervised
 * and how env vars are injected.
 *
 * Required env (loaded from monorepo .env if present):
 *   NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SECRET_KEY
 */
import { loadRootEnv } from '@b1dz/core';
loadRootEnv();
import { DaemonRuntime } from './runtime.js';

function fail(msg: string): never {
  console.error(`b1dzd: ${msg}`);
  process.exit(1);
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SECRET_KEY;
if (!url) fail('NEXT_PUBLIC_SUPABASE_URL missing');
if (!key) fail('SUPABASE_SECRET_KEY missing');

const runtime = new DaemonRuntime({ supabaseUrl: url, supabaseSecretKey: key });

// Periodic memory snapshot — 60s cadence, stderr so it bypasses any
// log-routing wrappers that filter "[...]" prefixed lines. Lets us
// observe heap growth over time to locate leak sources.
const memTimer = setInterval(() => {
  const m = process.memoryUsage();
  const fmt = (b: number) => `${(b / 1024 / 1024).toFixed(1)}MB`;
  process.stderr.write(`MEM: rss=${fmt(m.rss)} heapUsed=${fmt(m.heapUsed)}/${fmt(m.heapTotal)} external=${fmt(m.external)} arrayBuffers=${fmt(m.arrayBuffers)} uptime=${Math.floor(process.uptime())}s\n`);
}, 60_000);

const shutdown = async (signal: string) => {
  clearInterval(memTimer);
  console.log(`b1dzd: received ${signal}, shutting down…`);
  try { await runtime.stop(); } catch {}
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('uncaughtException', (e) => { console.error('b1dzd: uncaughtException', e); });
process.on('unhandledRejection', (e) => { console.error('b1dzd: unhandledRejection', e); });

await runtime.start();
// Keep alive — the runtime owns its own timers, this is just the wait
await new Promise<void>(() => {});
