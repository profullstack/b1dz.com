import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// A signup with the @profullstack/profile fields validates them before the
// user is created and stores them in public.user_profiles (keyed by user_id).
const mocks = vi.hoisted(() => ({ signUp: vi.fn(), upsert: vi.fn() }));

vi.mock('@supabase/ssr', () => ({
  createServerClient: vi.fn(() => ({ auth: { signUp: mocks.signUp } })),
}));
vi.mock('@/lib/auth-form-guard', () => ({
  signupGuard: null,
  checkAuthForm: async () => null,
}));
vi.mock('@/lib/supabase', () => ({
  createAdminSupabase: () => ({
    auth: {},
    from: (table: string) => ({
      upsert: (row: Record<string, unknown>, opts: unknown) => {
        mocks.upsert(table, row, opts);
        return { select: () => ({ single: async () => ({ data: row, error: null }) }) };
      },
    }),
  }),
}));

import { POST } from './signup/route';

function req(body: Record<string, unknown>) {
  return new NextRequest('https://b1dz.com/api/auth/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/auth/signup profile fields', () => {
  beforeEach(() => {
    mocks.signUp.mockReset();
    mocks.upsert.mockReset();
  });

  it('refuses a signup without a name and creates no user', async () => {
    const res = await POST(req({ email: 'ada@acme.com', password: 'password123' }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(Object.keys(body.errors)).toEqual(['first_name', 'last_name']);
    expect(mocks.signUp).not.toHaveBeenCalled();
  });

  it('stores the six fields in user_profiles after signup', async () => {
    mocks.signUp.mockResolvedValue({
      data: { user: { id: 'u1', email: 'ada@acme.com', identities: [{ id: 'i' }] }, session: null },
      error: null,
    });
    const res = await POST(req({
      email: 'ada@acme.com',
      password: 'password123',
      first_name: 'Ada',
      last_name: 'Lovelace',
      company_domain: 'https://www.acme.com/about',
      job_title: 'CTO',
      linkedin_url: 'in/ada-lovelace',
    }));
    expect(res.status).toBe(200);
    expect(mocks.signUp.mock.calls[0][0].options.data).toMatchObject({ first_name: 'Ada', last_name: 'Lovelace' });
    expect(mocks.upsert).toHaveBeenCalledTimes(1);
    const [table, row] = mocks.upsert.mock.calls[0];
    expect(table).toBe('user_profiles');
    expect(row).toMatchObject({
      user_id: 'u1',
      email: 'ada@acme.com',
      first_name: 'Ada',
      last_name: 'Lovelace',
      company_domain: 'acme.com',
      job_title: 'CTO',
      linkedin_url: 'https://www.linkedin.com/in/ada-lovelace',
    });
  });

  it('does not write a profile for an already-registered address', async () => {
    mocks.signUp.mockResolvedValue({ data: { user: null, session: null }, error: null });
    const res = await POST(req({ email: 'ada@acme.com', password: 'password123', first_name: 'Ada', last_name: 'L' }));
    expect(res.status).toBe(200);
    expect(mocks.upsert).not.toHaveBeenCalled();
  });
});
