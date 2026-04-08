import { runStorageContractTests } from '@b1dz/core';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonStorage } from './index.js';

runStorageContractTests('JsonStorage', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'b1dz-storage-test-'));
  // best-effort cleanup at process exit; per-test isolation comes from a
  // fresh tmpdir on every makeStorage() call
  process.on('exit', () => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });
  return new JsonStorage(dir);
});
