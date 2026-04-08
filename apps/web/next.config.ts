import type { NextConfig } from 'next';
import { loadRootEnv } from '@b1dz/core';

// Load .env from the monorepo root before Next reads its own env. This way
// the same .env powers the CLI, daemons, and the web app — no symlinks, no
// per-app duplicates.
loadRootEnv();

const config: NextConfig = {
  reactStrictMode: true,
  // Allow importing .ts source from workspace packages without a build step
  transpilePackages: ['@b1dz/core', '@b1dz/storage-json', '@b1dz/storage-supabase'],
};

export default config;
