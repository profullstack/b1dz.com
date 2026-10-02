import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const signUpMock = vi.fn();
const resetPasswordForEmailMock = vi.fn();

vi.mock('@supabase/ssr', () => ({
  createServerClient: vi.fn(() => ({
    auth: { signUp: signUpMock, resetPasswordForEmail: resetPasswordForEmailMock },
  })),
}));

const BROWSER_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';

function req(path: string, body: Record<string, unknown>, opts: { ua?: string; ip?: string } = {}) {
  return new NextRequest(`https://b1dz.com${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'user-agent': opts.ua ?? BROWSER_UA,
      'x-forwarded-for': opts.ip ?? '203.0.113.7',
    },
    body: JSON.stringify(body),
  });
}

/** Load the guard + routes fresh with a secret set, as production has. */
async function load() {
  vi.resetModules();
  vi.stubEnv('SUPABASE_SECRET_KEY', 'test-secret-for-form-guard');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://supabase.test');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'pk');
  const guard = await import('@/lib/auth-form-guard');
  const signup = await import('./signup/route');
  const reset = await import('./reset-password/route');
  return { guard, signup, reset };
}

/** A token minted as if the page rendered `ageMs` ago. */
async function tokenFields(g: Awaited<ReturnType<typeof load>>['guard'], which: 'signupGuard' | 'resetGuard', ageMs = 5_000) {
  const guard = g[which]!;
  const token = await guard.issue(Date.now() - ageMs);
  const f = guard.fields(token);
  return { [f.token.name]: token, [f.honeypot.name]: '' };
}

describe('auth form guard', () => {
  beforeEach(() => {
    signUpMock.mockReset().mockResolvedValue({ data: { user: { id: 'u1', email: 'a@b.com' }, session: null }, error: null });
    resetPasswordForEmailMock.mockReset().mockResolvedValue({ error: null });
  });

  it('lets a rendered, human-paced signup through', async () => {
    const m = await load();
    const res = await m.signup.POST(req('/api/auth/signup', { email: 'a@b.com', password: 'password123', ...(await tokenFields(m.guard, 'signupGuard')) }));
    expect(res.status).toBe(200);
    expect(signUpMock).toHaveBeenCalledTimes(1);
  });

  it('drops a signup that never rendered the page: fake success, no mail', async () => {
    const m = await load();
    const res = await m.signup.POST(req('/api/auth/signup', { email: 'victim@example.com', password: 'password123' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ user: null, session: null, needsEmailConfirmation: true });
    expect(signUpMock).not.toHaveBeenCalled();
  });

  it('asks a too-fast submission to retry rather than dropping it', async () => {
    const m = await load();
    const res = await m.signup.POST(req('/api/auth/signup', { email: 'a@b.com', password: 'password123', ...(await tokenFields(m.guard, 'signupGuard', 0)) }));
    expect(res.status).toBe(400);
    expect(signUpMock).not.toHaveBeenCalled();
  });

  it('silently drops a filled honeypot: same answer as success, no mail', async () => {
    const m = await load();
    const fields = await tokenFields(m.guard, 'signupGuard');
    const honeypot = m.guard.signupGuard!.fields('x').honeypot.name;
    const res = await m.signup.POST(req('/api/auth/signup', { email: 'victim@example.com', password: 'password123', ...fields, [honeypot]: 'gotcha' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ user: null, session: null, needsEmailConfirmation: true });
    expect(signUpMock).not.toHaveBeenCalled();
  });

  it('refuses the scripted quoted user-agent with a 403 ThreatCrush can ban on', async () => {
    const m = await load();
    const res = await m.signup.POST(req('/api/auth/signup', { email: 'victim@example.com', password: 'password123', ...(await tokenFields(m.guard, 'signupGuard')) }, { ua: `"${BROWSER_UA}"` }));
    expect(res.status).toBe(403);
    expect(signUpMock).not.toHaveBeenCalled();
  });

  it('keys the rate limit on X-Real-IP, so a forged CF-Connecting-IP buys no fresh budget', async () => {
    const m = await load();
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const r = req('/api/auth/signup', { email: `s${i}@b.com`, password: 'password123', ...(await tokenFields(m.guard, 'signupGuard')) }, { ip: '192.0.2.44' });
      r.headers.set('x-real-ip', '192.0.2.44');
      r.headers.set('cf-connecting-ip', `10.9.8.${i}`);
      statuses.push((await m.signup.POST(r)).status);
    }
    expect(statuses[5]).toBe(429);
  });

  it('rate-limits a sixth attempt from one address within the hour', async () => {
    const m = await load();
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await m.signup.POST(req('/api/auth/signup', { email: `a${i}@b.com`, password: 'password123', ...(await tokenFields(m.guard, 'signupGuard')) }, { ip: '198.51.100.9' }));
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    expect(statuses[5]).toBe(429);
    expect(signUpMock).toHaveBeenCalledTimes(5);
  });

  it('guards password reset the same way', async () => {
    const m = await load();
    const bare = await m.reset.POST(req('/api/auth/reset-password', { email: 'victim@example.com' }));
    expect(bare.status).toBe(200);
    expect(await bare.json()).toEqual({ ok: true });
    expect(resetPasswordForEmailMock).not.toHaveBeenCalled();

    const ok = await m.reset.POST(req('/api/auth/reset-password', { email: 'a@b.com', ...(await tokenFields(m.guard, 'resetGuard')) }));
    expect(ok.status).toBe(200);
    expect(resetPasswordForEmailMock).toHaveBeenCalledTimes(1);
  });

  it('a signup token does not open the reset form', async () => {
    const m = await load();
    const res = await m.reset.POST(req('/api/auth/reset-password', { email: 'a@b.com', ...(await tokenFields(m.guard, 'signupGuard')) }));
    expect(await res.json()).toEqual({ ok: true });
    expect(resetPasswordForEmailMock).not.toHaveBeenCalled();
  });
});
