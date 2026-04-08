/**
 * Walk up from `start` until we find `pnpm-workspace.yaml` and return that
 * directory. Used by every app to locate the monorepo root so .env loading
 * is consistent regardless of cwd.
 */
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export function findMonorepoRoot(start: string = process.cwd()): string {
  let dir = resolve(start);
  for (let i = 0; i < 20; i++) {
    if (existsSync(resolve(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Fall back to start so callers don't crash if invoked outside the workspace
  return start;
}

/**
 * Load `.env` from the monorepo root into process.env. Idempotent.
 * Uses Node's built-in env file loader if available, falls back to a tiny
 * parser otherwise so we don't force a dotenv dependency on every package.
 */
export function loadRootEnv(): string {
  const root = findMonorepoRoot();
  const path = resolve(root, '.env');
  if (!existsSync(path)) return path;
  // Node 22+ supports `process.loadEnvFile(path)` natively
  const proc = process as unknown as { loadEnvFile?: (p: string) => void };
  if (typeof proc.loadEnvFile === 'function') {
    try { proc.loadEnvFile(path); return path; } catch {}
  }
  // Tiny fallback parser — supports KEY=VALUE and KEY='VALUE' / KEY="VALUE"
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs') as { readFileSync: (p: string, e: string) => string };
  const text = fs.readFileSync(path, 'utf8');
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
  return path;
}
