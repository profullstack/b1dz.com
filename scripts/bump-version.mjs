#!/usr/bin/env node
/**
 * Bump version across the entire workspace.
 *
 * Usage:
 *   node scripts/bump-version.mjs patch    # 0.1.0 → 0.1.1
 *   node scripts/bump-version.mjs minor    # 0.1.0 → 0.2.0
 *   node scripts/bump-version.mjs major    # 0.1.0 → 1.0.0
 *   node scripts/bump-version.mjs 0.5.0    # explicit
 *
 * Updates EVERY package.json under apps/ and packages/, plus the root and
 * the browser extension manifest.json. All packages stay locked at the same
 * version — no per-package drift.
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

function bump(version, kind) {
  if (/^\d+\.\d+\.\d+/.test(kind)) return kind; // explicit version
  const [maj, min, pat] = version.split('.').map(Number);
  if (kind === 'patch') return `${maj}.${min}.${pat + 1}`;
  if (kind === 'minor') return `${maj}.${min + 1}.0`;
  if (kind === 'major') return `${maj + 1}.0.0`;
  throw new Error(`unknown bump kind: ${kind}`);
}

function readJson(path) { return JSON.parse(readFileSync(path, 'utf8')); }
function writeJson(path, value) { writeFileSync(path, JSON.stringify(value, null, 2) + '\n'); }

function findPackageFiles() {
  const files = [join(root, 'package.json')];
  for (const dir of ['apps', 'packages']) {
    const base = join(root, dir);
    if (!existsSync(base)) continue;
    for (const name of readdirSync(base)) {
      const pkg = join(base, name, 'package.json');
      if (existsSync(pkg)) files.push(pkg);
    }
  }
  // Browser extension manifest
  const manifest = join(root, 'apps', 'extension', 'manifest.json');
  if (existsSync(manifest)) files.push(manifest);
  return files;
}

const kind = process.argv[2];
if (!kind) {
  console.error('usage: bump-version.mjs <patch|minor|major|x.y.z>');
  process.exit(1);
}

const rootPkg = readJson(join(root, 'package.json'));
const next = bump(rootPkg.version, kind);
console.log(`bumping ${rootPkg.version} → ${next}`);

let updated = 0;
for (const path of findPackageFiles()) {
  const data = readJson(path);
  if (data.version === undefined) continue;
  data.version = next;
  writeJson(path, data);
  console.log(`  ✓ ${path.replace(root + '/', '')}`);
  updated++;
}
console.log(`updated ${updated} file(s) to ${next}`);
