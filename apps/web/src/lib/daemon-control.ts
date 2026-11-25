/**
 * Web -> daemon control channel for unlock sessions.
 *
 * The daemon listens on loopback only (B1DZ_DAEMON_CONTROL_URL, default
 * http://127.0.0.1:8790) and requires B1DZ_DAEMON_CONTROL_TOKEN, which
 * scripts/start-railway.sh generates fresh per container boot when unset.
 * The web app authenticates the user, then forwards { userId, dataKey, ttl }.
 * The data key passes through this process in memory only: never logged,
 * never stored, never put in a DB or queue.
 */
export interface DaemonSessionStatus {
  unlocked: boolean;
  expiresAt: string | null;
  reachable: boolean;
}

function controlUrl(): string {
  return (process.env.B1DZ_DAEMON_CONTROL_URL || 'http://127.0.0.1:8790').replace(/\/$/, '');
}

function controlHeaders(): Record<string, string> {
  const token = process.env.B1DZ_DAEMON_CONTROL_TOKEN;
  if (!token) throw new Error('daemon control channel not configured');
  return { 'content-type': 'application/json', 'x-b1dz-control-token': token };
}

async function call(path: string, body: Record<string, unknown>, timeoutMs = 10_000): Promise<Response> {
  return fetch(`${controlUrl()}${path}`, {
    method: 'POST',
    headers: controlHeaders(),
    body: JSON.stringify(body),
    cache: 'no-store',
    signal: AbortSignal.timeout(timeoutMs),
  });
}

export type EquityAction = 'account' | 'order' | 'cancel' | 'confirm';

/**
 * Manual equity trading for the research terminal. The daemon holds the
 * user's unlocked broker credentials; this process only relays the ticket and
 * the daemon's answer (which is already safe to show the user).
 *
 * A placed order is not idempotent at the broker, so a timeout here is
 * reported as "unknown, check your orders", never retried.
 */
export async function daemonEquity(action: EquityAction, userId: string, body: Record<string, unknown> = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  let res: Response;
  try {
    res = await call(`/equity/${action}`, { ...body, userId }, 25_000);
  } catch (e) {
    const timedOut = (e as Error).name === 'TimeoutError';
    if (timedOut && (action === 'order' || action === 'confirm')) {
      return { status: 504, body: { error: 'The broker did not answer in time. The order may or may not have been placed: check your open orders before sending it again.', unknown: true } };
    }
    return { status: 503, body: { error: 'trading daemon unreachable; try again shortly' } };
  }
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, body: json };
}

export async function daemonUnlock(userId: string, dataKey: string, ttlSeconds: number): Promise<{ ok: boolean; status: number; body: unknown }> {
  const res = await call('/unlock', { userId, dataKey, ttlSeconds });
  return { ok: res.ok, status: res.status, body: await res.json().catch(() => ({})) };
}

export async function daemonLock(userId: string): Promise<{ ok: boolean; status: number; body: unknown }> {
  const res = await call('/lock', { userId });
  return { ok: res.ok, status: res.status, body: await res.json().catch(() => ({})) };
}

export async function daemonStatus(userId: string): Promise<DaemonSessionStatus> {
  try {
    const res = await call('/status', { userId });
    if (!res.ok) return { unlocked: false, expiresAt: null, reachable: false };
    const b = (await res.json()) as { unlocked?: boolean; expiresAt?: string | null };
    return { unlocked: !!b.unlocked, expiresAt: b.expiresAt ?? null, reachable: true };
  } catch {
    return { unlocked: false, expiresAt: null, reachable: false };
  }
}
