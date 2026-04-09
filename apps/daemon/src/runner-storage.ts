/**
 * runnerStorageFor(ctx) — thin adapter that lets @b1dz/source-dealdash
 * treat the daemon's UserContext as a Storage instance.
 *
 * Everything pollOnce writes goes through ctx.savePayload so the daemon
 * stays the single owner of per-user state. We only need the two methods
 * pollOnce uses: get + put on the 'source-state' collection keyed by
 * source id.
 */

import type { Storage } from '@b1dz/core';
import type { UserContext } from './types.js';

export function runnerStorageFor(ctx: UserContext): Storage {
  return {
    async get<T>(_collection: string, _key: string): Promise<T | null> {
      // pollOnce only reads source_state. Return the current payload.
      return ctx.payload as T;
    },
    async put<T>(_collection: string, _key: string, value: T): Promise<void> {
      // pollOnce writes the entire next state — merge it in through the
      // runner's savePayload so other workers / tick phases also see it.
      await ctx.savePayload(value as Record<string, unknown>);
    },
    async delete(_collection: string, _key: string): Promise<void> { /* no-op */ },
    async list<T>(_collection: string): Promise<T[]> { return []; },
    async query<T>(_collection: string, _pred: (v: T) => boolean): Promise<T[]> { return []; },
  };
}
