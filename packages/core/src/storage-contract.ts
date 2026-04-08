/**
 * Reusable contract test for any Storage implementation.
 *
 * Every adapter (JsonStorage, SupabaseStorage, future MemoryStorage…) imports
 * `runStorageContractTests(makeStorage)` to prove it satisfies the same
 * semantics. This is the single source of truth for what "Storage" means.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { Storage } from './storage.js';

export function runStorageContractTests(label: string, makeStorage: () => Promise<Storage>) {
  describe(`Storage contract: ${label}`, () => {
    let storage: Storage;
    beforeEach(async () => {
      storage = await makeStorage();
    });

    it('get returns null for missing keys', async () => {
      expect(await storage.get('opportunities', 'nope')).toBeNull();
    });

    it('put then get returns the value', async () => {
      await storage.put('opportunities', 'k1', { hello: 'world' });
      expect(await storage.get('opportunities', 'k1')).toEqual({ hello: 'world' });
    });

    it('put overwrites existing values', async () => {
      await storage.put('opportunities', 'k1', { v: 1 });
      await storage.put('opportunities', 'k1', { v: 2 });
      expect(await storage.get('opportunities', 'k1')).toEqual({ v: 2 });
    });

    it('delete removes the value', async () => {
      await storage.put('opportunities', 'k1', { v: 1 });
      await storage.delete('opportunities', 'k1');
      expect(await storage.get('opportunities', 'k1')).toBeNull();
    });

    it('list returns all values in a collection', async () => {
      await storage.put('opportunities', 'a', { n: 1 });
      await storage.put('opportunities', 'b', { n: 2 });
      const all = await storage.list<{ n: number }>('opportunities');
      const ns = all.map((x) => x.n).sort();
      expect(ns).toEqual([1, 2]);
    });

    it('list returns empty array for empty collection', async () => {
      expect(await storage.list('source-state')).toEqual([]);
    });

    it('query filters by predicate', async () => {
      await storage.put('opportunities', 'a', { n: 1 });
      await storage.put('opportunities', 'b', { n: 2 });
      await storage.put('opportunities', 'c', { n: 3 });
      const evens = await storage.query<{ n: number }>('opportunities', (v) => v.n % 2 === 0);
      expect(evens.map((x) => x.n)).toEqual([2]);
    });

    it('collections are independent', async () => {
      await storage.put('opportunities', 'k', { from: 'opps' });
      await storage.put('alerts', 'k', { from: 'alerts' });
      expect(await storage.get('opportunities', 'k')).toEqual({ from: 'opps' });
      expect(await storage.get('alerts', 'k')).toEqual({ from: 'alerts' });
    });
  });
}
