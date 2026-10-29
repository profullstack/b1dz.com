import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { findMonorepoRoot } from './env.js';

let cachedVersion: string | null = null;

export function getB1dzVersion(): string {
  if (cachedVersion) return cachedVersion;

  // The npm build of the CLI (@profullstack/b1dz) bakes its version in.
  const bundled = process.env.B1DZ_BUNDLED_VERSION;
  if (bundled) {
    cachedVersion = bundled;
    return cachedVersion;
  }

  try {
    const root = findMonorepoRoot();
    const pkgPath = resolve(root, 'package.json');
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string };
      if (pkg.version) {
        cachedVersion = pkg.version;
        return cachedVersion;
      }
    }
  } catch {}

  cachedVersion = '0.0.0-unknown';
  return cachedVersion;
}
