/**
 * JSON file storage adapter — implements the @b1dz/core Storage interface
 * by reading/writing one file per collection.
 *
 * Each collection lives at `${root}/${collection}.json` as a flat object
 * map of `key → value`. Cheap and good enough for the bootstrap phase.
 * Swap with the Supabase adapter once we outgrow file IO.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Storage } from '@b1dz/core';

export class JsonStorage implements Storage {
  constructor(private root: string) {
    if (!existsSync(root)) mkdirSync(root, { recursive: true });
  }

  private path(collection: string): string {
    return join(this.root, `${collection}.json`);
  }

  private load<T>(collection: string): Record<string, T> {
    const p = this.path(collection);
    if (!existsSync(p)) return {};
    try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return {}; }
  }

  private save<T>(collection: string, data: Record<string, T>) {
    writeFileSync(this.path(collection), JSON.stringify(data, null, 2));
  }

  async get<T>(collection: string, key: string): Promise<T | null> {
    return (this.load<T>(collection)[key] ?? null) as T | null;
  }

  async put<T>(collection: string, key: string, value: T): Promise<void> {
    const data = this.load<T>(collection);
    data[key] = value;
    this.save(collection, data);
  }

  async delete(collection: string, key: string): Promise<void> {
    const data = this.load(collection);
    delete data[key];
    this.save(collection, data);
  }

  async list<T>(collection: string): Promise<T[]> {
    return Object.values(this.load<T>(collection));
  }

  async query<T>(collection: string, predicate: (v: T) => boolean): Promise<T[]> {
    return (await this.list<T>(collection)).filter(predicate);
  }
}
