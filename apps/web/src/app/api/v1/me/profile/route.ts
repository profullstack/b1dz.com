import type { NextRequest } from 'next/server';
import { createProfileHandlers } from '@profullstack/profile';
import { authenticate } from '@/lib/api-auth';
import { profileStore } from '@/lib/profile';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// GET / PUT / PATCH /api/v1/me/profile: the signed-in user's profile fields
// (cookie session or Bearer token).
const handlers = () =>
  createProfileHandlers({
    store: profileStore(),
    getUser: async (req) => {
      const auth = await authenticate(req as NextRequest);
      return auth ? { id: auth.userId, email: auth.email } : null;
    },
  });

export const GET = (req: NextRequest) => handlers().GET(req);
export const PUT = (req: NextRequest) => handlers().PUT(req);
export const PATCH = (req: NextRequest) => handlers().PATCH(req);
