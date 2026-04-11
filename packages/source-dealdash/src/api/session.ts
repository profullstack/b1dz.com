/**
 * DealDash session health monitor.
 *
 * Detects three states:
 *   - healthy:       normal 200 responses
 *   - session-expired: 401/403 that resolves with a fresh login
 *   - banned:         repeated auth failures, or a known ban response
 *
 * The daemon / TUI checks `sessionHealth()` after every fetch. If the
 * state transitions to 'banned', ALL activity stops immediately.
 */

export type SessionState = 'healthy' | 'session-expired' | 'banned' | 'unknown';

export interface SessionHealth {
  state: SessionState;
  /** Number of consecutive auth failures this session */
  consecutiveAuthFailures: number;
  /** Last error body for debugging */
  lastError?: string;
  /** When the state last changed */
  changedAt: number;
}

// Thresholds
const BAN_FAILURE_THRESHOLD = 5; // 5 consecutive auth failures → assume ban

// Known ban indicators in DealDash responses
const BAN_PATTERNS = [
  /account.*suspend/i,
  /account.*banned/i,
  /account.*disabled/i,
  /account.*blocked/i,
  /violation.*terms/i,
  /access.*denied.*permanently/i,
  /your account has been/i,
];

export function createSessionHealth(): SessionHealth {
  return { state: 'unknown', consecutiveAuthFailures: 0, changedAt: Date.now() };
}

/**
 * Call after every DealDash HTTP response. Returns the updated health
 * and whether the state transitioned (so the caller can alert).
 */
export function checkResponse(
  health: SessionHealth,
  status: number,
  body?: string,
): { health: SessionHealth; transition: SessionState | null } {
  const prev = health.state;

  // Check for explicit ban language in any response
  if (body) {
    for (const re of BAN_PATTERNS) {
      if (re.test(body)) {
        const next: SessionHealth = {
          state: 'banned',
          consecutiveAuthFailures: health.consecutiveAuthFailures + 1,
          lastError: body.slice(0, 500),
          changedAt: Date.now(),
        };
        return { health: next, transition: prev !== 'banned' ? 'banned' : null };
      }
    }
  }

  // Auth failures
  if (status === 401 || status === 403) {
    const failures = health.consecutiveAuthFailures + 1;
    if (failures >= BAN_FAILURE_THRESHOLD) {
      const next: SessionHealth = {
        state: 'banned',
        consecutiveAuthFailures: failures,
        lastError: body?.slice(0, 500),
        changedAt: Date.now(),
      };
      return { health: next, transition: prev !== 'banned' ? 'banned' : null };
    }
    const next: SessionHealth = {
      state: 'session-expired',
      consecutiveAuthFailures: failures,
      lastError: body?.slice(0, 500),
      changedAt: Date.now(),
    };
    return { health: next, transition: prev !== 'session-expired' ? 'session-expired' : null };
  }

  // Success — reset counter
  if (status >= 200 && status < 400) {
    const next: SessionHealth = {
      state: 'healthy',
      consecutiveAuthFailures: 0,
      changedAt: health.state !== 'healthy' ? Date.now() : health.changedAt,
    };
    return { health: next, transition: prev !== 'healthy' ? 'healthy' : null };
  }

  // Other errors (5xx, etc.) — don't count toward ban detection
  return { health, transition: null };
}

/**
 * Wrap a DealDashFetcher with session health monitoring + automatic
 * stop on ban detection.
 */
export function withSessionMonitor(
  fetcher: (path: string, init?: RequestInit) => Promise<Response>,
  onTransition?: (state: SessionState, health: SessionHealth) => void,
): {
  fetch: (path: string, init?: RequestInit) => Promise<Response>;
  getHealth: () => SessionHealth;
} {
  let health = createSessionHealth();

  const monitoredFetch = async (path: string, init?: RequestInit): Promise<Response> => {
    if (health.state === 'banned') {
      throw new Error(`DealDash account appears BANNED — all requests blocked. Last error: ${health.lastError}`);
    }
    const res = await fetcher(path, init);
    // Always read the body — ban language can appear in 200 responses too
    // (e.g. DealDash serves a "your account is suspended" page with 200).
    const body = await res.clone().text().catch(() => '');
    const result = checkResponse(health, res.status, body);
    health = result.health;
    if (result.transition && onTransition) {
      onTransition(result.transition, health);
    }
    return res;
  };

  return { fetch: monitoredFetch, getHealth: () => health };
}
