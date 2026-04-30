import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { authJson, siteOrigin } from '@/lib/auth-route-client';

export async function POST(req: NextRequest) {
  const { response, supabase } = authJson(req, {});
  await supabase.auth.signOut().catch(() => null);

  const redirect = NextResponse.redirect(new URL('/login', siteOrigin(req)), { status: 303 });
  for (const cookie of response.cookies.getAll()) {
    redirect.cookies.set(cookie);
  }
  return redirect;
}
