/**
 * In-memory unlock sessions: userId -> data key, with a TTL.
 *
 * The ONLY place the daemon holds a user's data key. Never written to the DB,
 * Redis, disk, logs, error reports or process.env. A restart empties it, so
 * every sealed user is locked until they unlock again (their workers pause
 * with status "locked"). Lock and expiry zero the key buffer.
 */
import {
  UNLOCK_DEFAULT_TTL_SECONDS,
  clampUnlockTtlSeconds,
} from '@b1dz/core/sealed-secrets';

interface Session {
  key: Uint8Array;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout> | null;
}

export interface UnlockStatus {
  unlocked: boolean;
  expiresAt: string | null;
}

type Listener = (userId: string, unlocked: boolean) => void;

export class UnlockStore {
  private sessions = new Map<string, Session>();
  private listeners = new Set<Listener>();

  constructor(private now: () => number = Date.now, private useTimers = true) {}

  onChange(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(userId: string, unlocked: boolean) {
    for (const fn of this.listeners) {
      try { fn(userId, unlocked); } catch { /* listeners never break the store */ }
    }
  }

  /** Store a COPY of the key; the caller should wipe its own buffer. */
  unlock(userId: string, key: Uint8Array, ttlSeconds: number = UNLOCK_DEFAULT_TTL_SECONDS): UnlockStatus {
    if (!userId) throw new Error('userId required');
    if (key.length !== 32) throw new Error('data key must be 32 bytes');
    this.drop(userId, false);
    const ttl = clampUnlockTtlSeconds(ttlSeconds);
    const expiresAt = this.now() + ttl * 1000;
    const timer = this.useTimers ? setTimeout(() => this.lock(userId), ttl * 1000) : null;
    timer?.unref?.();
    this.sessions.set(userId, { key: new Uint8Array(key), expiresAt, timer });
    this.emit(userId, true);
    return { unlocked: true, expiresAt: new Date(expiresAt).toISOString() };
  }

  /** The user's data key while unlocked, else null. Callers must not retain it past the tick. */
  get(userId: string): Uint8Array | null {
    const s = this.sessions.get(userId);
    if (!s) return null;
    if (s.expiresAt <= this.now()) {
      this.lock(userId);
      return null;
    }
    return s.key;
  }

  status(userId: string): UnlockStatus {
    return this.get(userId)
      ? { unlocked: true, expiresAt: new Date(this.sessions.get(userId)!.expiresAt).toISOString() }
      : { unlocked: false, expiresAt: null };
  }

  lock(userId: string): void {
    this.drop(userId, true);
  }

  private drop(userId: string, notify: boolean) {
    const s = this.sessions.get(userId);
    if (!s) return;
    if (s.timer) clearTimeout(s.timer);
    s.key.fill(0);
    this.sessions.delete(userId);
    if (notify) this.emit(userId, false);
  }

  lockAll(): void {
    for (const userId of [...this.sessions.keys()]) this.lock(userId);
  }

  size(): number {
    return this.sessions.size;
  }
}

/** Process-wide store. */
export const unlockStore = new UnlockStore();
