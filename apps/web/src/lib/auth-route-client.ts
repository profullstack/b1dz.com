import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const PUB = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;

export function siteOrigin(req: NextRequest): string {
  return process.env.NEXT_PUBLIC_SITE_URL || req.nextUrl.origin;
}

export function safeNextPath(next: string | null | undefined, fallback = '/dashboard'): string {
  if (!next || !next.startsWith('/') || next.startsWith('//')) return fallback;
  return next;
}

export function authJson(req: NextRequest, _body: unknown, init?: ResponseInit) {
  const response = new NextResponse(null, init);
  return { response, supabase: createRouteSupabaseClient(req, response) };
}

export function authRedirect(req: NextRequest, nextPath: string) {
  const response = NextResponse.redirect(new URL(safeNextPath(nextPath), siteOrigin(req)));
  return { response, supabase: createRouteSupabaseClient(req, response) };
}

export function withAuthCookies(responseWithCookies: NextResponse, body: unknown, init?: ResponseInit) {
  const finalResponse = new Response(JSON.stringify(body), {
    status: init?.status ?? responseWithCookies.status,
    headers: responseWithCookies.headers,
  });
  finalResponse.headers.set('content-type', 'application/json');
  return finalResponse;
}

function createRouteSupabaseClient(req: NextRequest, response: NextResponse) {
  return createServerClient(URL_, PUB, {
    cookies: {
      getAll: () => req.cookies.getAll(),
      setAll: (cookiesToSet) => {
        cookiesToSet.forEach(({ name, value, options }) => {
          response.cookies.set(name, value, options);
        });
      },
    },
  });
}
