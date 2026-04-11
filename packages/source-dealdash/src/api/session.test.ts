/**
 * Contract tests for the session health monitor. Every detection path
 * that could make the daemon stop (or not stop) is locked in here.
 */

import { describe, it, expect } from 'vitest';
import { createSessionHealth, checkResponse, withSessionMonitor } from './session.js';

describe('checkResponse', () => {
  it('transitions to healthy on a 200', () => {
    const h = createSessionHealth();
    const r = checkResponse(h, 200);
    expect(r.health.state).toBe('healthy');
    expect(r.health.consecutiveAuthFailures).toBe(0);
  });

  it('transitions to session-expired on a single 401', () => {
    const h = createSessionHealth();
    const r = checkResponse(h, 401, 'invalid token');
    expect(r.health.state).toBe('session-expired');
    expect(r.health.consecutiveAuthFailures).toBe(1);
    expect(r.transition).toBe('session-expired');
  });

  it('counts consecutive 403s and trips banned at threshold', () => {
    let h = createSessionHealth();
    for (let i = 0; i < 4; i++) {
      const r = checkResponse(h, 403);
      h = r.health;
      expect(h.state).toBe('session-expired');
    }
    // 5th failure crosses the threshold
    const r = checkResponse(h, 403);
    expect(r.health.state).toBe('banned');
    expect(r.transition).toBe('banned');
  });

  it('resets counter on a successful response', () => {
    let h = createSessionHealth();
    for (let i = 0; i < 3; i++) h = checkResponse(h, 401).health;
    expect(h.consecutiveAuthFailures).toBe(3);
    h = checkResponse(h, 200).health;
    expect(h.consecutiveAuthFailures).toBe(0);
    expect(h.state).toBe('healthy');
  });

  it('detects explicit ban language in the response body', () => {
    const h = createSessionHealth();
    const r = checkResponse(h, 200, 'Your account has been suspended for violating our terms');
    expect(r.health.state).toBe('banned');
    expect(r.transition).toBe('banned');
  });

  it('detects various ban phrasings', () => {
    const phrases = [
      'account suspended',
      'account banned',
      'account disabled',
      'Account Blocked',
      'violation of terms',
      'access denied permanently',
    ];
    for (const text of phrases) {
      const r = checkResponse(createSessionHealth(), 200, text);
      expect(r.health.state).toBe('banned');
    }
  });

  it('does NOT trip on non-ban text even with 4xx', () => {
    const r = checkResponse(createSessionHealth(), 404, 'auction not found');
    expect(r.health.state).toBe('unknown'); // 404 is not auth failure
  });

  it('does NOT count 5xx errors toward ban detection', () => {
    let h = createSessionHealth();
    for (let i = 0; i < 10; i++) h = checkResponse(h, 500).health;
    expect(h.state).not.toBe('banned');
    expect(h.consecutiveAuthFailures).toBe(0);
  });
});

describe('withSessionMonitor', () => {
  it('blocks requests after detecting a ban', async () => {
    let callCount = 0;
    const baseFetcher = async () => {
      callCount++;
      return new Response('account suspended', { status: 200 });
    };
    const { fetch: monitored } = withSessionMonitor(baseFetcher);

    // First call triggers ban detection (body matches)
    await monitored('/test');
    expect(callCount).toBe(1);

    // Second call should throw without making a request
    await expect(monitored('/test2')).rejects.toThrow(/BANNED/);
    expect(callCount).toBe(1); // NOT 2
  });

  it('fires the onTransition callback on state change', async () => {
    const transitions: string[] = [];
    const baseFetcher = async () => new Response('', { status: 200 });
    const { fetch: monitored } = withSessionMonitor(baseFetcher, (state) => {
      transitions.push(state);
    });
    await monitored('/test');
    expect(transitions).toEqual(['healthy']);
  });
});
