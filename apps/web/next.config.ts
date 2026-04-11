import type { NextConfig } from 'next';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

// Load .env from the monorepo root before Next reads its own env. We can't
// import @b1dz/core here because Next 16's TS config loader is CJS and
// doesn't follow ESM .js specifiers used by workspace packages — so we
// inline the same logic.
function loadRootEnv() {
  let dir = process.cwd();
  for (let i = 0; i < 20; i++) {
    if (existsSync(resolve(dir, 'pnpm-workspace.yaml'))) break;
    const parent = dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
  const path = resolve(dir, '.env');
  if (!existsSync(path)) return;
  const proc = process as unknown as { loadEnvFile?: (p: string) => void };
  if (typeof proc.loadEnvFile === 'function') { try { proc.loadEnvFile(path); return; } catch {} }
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = val;
  }
}
loadRootEnv();

const config: NextConfig = {
  reactStrictMode: true,
  typescript: { ignoreBuildErrors: true },
  transpilePackages: [
    '@b1dz/core',
    '@b1dz/sdk',
    '@b1dz/storage-json',
    '@b1dz/storage-supabase',
    '@b1dz/storage-b1dz-api',
  ],
  // Resolve .js imports to .ts in workspace packages (ESM TypeScript convention)
  webpack: (config) => {
    config.resolve = config.resolve || {};
    config.resolve.extensionAlias = {
      '.js': ['.ts', '.tsx', '.js'],
      '.mjs': ['.mts', '.mjs'],
    };
    return config;
  },
};

export default config;
