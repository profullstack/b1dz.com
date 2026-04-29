import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const signInWithPasswordMock = vi.fn();
const signUpMock = vi.fn();
const resetPasswordForEmailMock = vi.fn();
const updateUserMock = vi.fn();
const exchangeCodeForSessionMock = vi.fn();
const getUserMock = vi.fn();

vi.mock('@supabase/ssr', () => ({
  createServerClient: vi.fn((_url: string, _key: string, options: { cookies: { setAll: (cookies: Array<{ name: string; value: string; options?: Record<string, unknown> }>) => void } }) => {
    const setSessionCookie = () => options.cookies.setAll([
      { name: 'sb-test-auth-token', value: 'cookie-value', options: { path: '/', httpOnly: true } },
    ]);
    return {
      auth: {
        signInWithPassword: async (...args: unknown[]) => {
          const result = await signInWithPasswordMock(...args);
          if (!result.error) setSessionCookie();
          return result;
        },
        signUp: async (...args: unknown[]) => {
          const result = await signUpMock(...args);
          if (!result.error && result.data?.session) setSessionCookie();
          return result;
        },
        resetPasswordForEmail: resetPasswordForEmailMock,
        updateUser: updateUserMock,
        exchangeCodeForSession: async (...args: unknown[]) => {
          const result = await exchangeCodeForSessionMock(...args);
          if (!result.error) setSessionCookie();
          return result;
        },
        getUser: getUserMock,
      },
    };
  }),
}));

function jsonReq(path: string, body: unknown) {
  return new NextRequest(`https://b1dz.com${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('web auth route handlers', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://supabase.test';
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = 'pub-test';
    process.env.NEXT_PUBLIC_SITE_URL = 'https://b1dz.com';
  });

  it('sets Supabase auth cookies when login succeeds', async () => {
    signInWithPasswordMock.mockResolvedValue({
      data: {
        user: { id: 'user-1', email: 'dev@b1dz.com' },
        session: { access_token: 'access', refresh_token: 'refresh', expires_at: 123 },
      },
      error: null,
    });
    const { POST } = await import('./login/route');

    const res = await POST(jsonReq('/api/auth/login', { email: 'dev@b1dz.com', password: 'password123' }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.user).toEqual({ id: 'user-1', email: 'dev@b1dz.com' });
    expect(res.headers.get('set-cookie')).toContain('sb-test-auth-token=cookie-value');
    expect(signInWithPasswordMock).toHaveBeenCalledWith({ email: 'dev@b1dz.com', password: 'password123' });
  });

  it('sets Supabase auth cookies when signup returns a session', async () => {
    signUpMock.mockResolvedValue({
      data: {
        user: { id: 'user-2', email: 'new@b1dz.com' },
        session: { access_token: 'access', refresh_token: 'refresh', expires_at: 456 },
      },
      error: null,
    });
    const { POST } = await import('./signup/route');

    const res = await POST(jsonReq('/api/auth/signup', { email: 'new@b1dz.com', password: 'password123' }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.user).toEqual({ id: 'user-2', email: 'new@b1dz.com' });
    expect(res.headers.get('set-cookie')).toContain('sb-test-auth-token=cookie-value');
    expect(signUpMock).toHaveBeenCalledWith(expect.objectContaining({
      email: 'new@b1dz.com',
      password: 'password123',
      options: { emailRedirectTo: 'https://b1dz.com/auth/callback?next=/dashboard' },
    }));
  });

  it('sends password reset emails with callback redirect', async () => {
    resetPasswordForEmailMock.mockResolvedValue({ data: {}, error: null });
    const { POST } = await import('./reset-password/route');

    const res = await POST(jsonReq('/api/auth/reset-password', { email: 'dev@b1dz.com' }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(resetPasswordForEmailMock).toHaveBeenCalledWith('dev@b1dz.com', {
      redirectTo: 'https://b1dz.com/auth/callback?next=/reset-password',
    });
  });

  it('updates password for the currently recovered session', async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });
    updateUserMock.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });
    const { POST } = await import('./update-password/route');

    const res = await POST(jsonReq('/api/auth/update-password', { password: 'newpassword123' }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(updateUserMock).toHaveBeenCalledWith({ password: 'newpassword123' });
  });

  it('exchanges Supabase callback code for cookies and redirects to next path', async () => {
    exchangeCodeForSessionMock.mockResolvedValue({ data: { session: {} }, error: null });
    const { GET } = await import('../../auth/callback/route');

    const res = await GET(new NextRequest('https://b1dz.com/auth/callback?code=abc&next=/dashboard'));

    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('https://b1dz.com/dashboard');
    expect(res.headers.get('set-cookie')).toContain('sb-test-auth-token=cookie-value');
    expect(exchangeCodeForSessionMock).toHaveBeenCalledWith('abc');
  });
});
