/**
 * Auth proxy — redirects www → apex, refreshes the Supabase session on every
 * request, and gates non-public routes. Lifted from the official @supabase/ssr docs.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { getB1dzVersion } from '@b1dz/core';
import { createServerClient } from '@supabase/ssr';

// API routes self-authenticate via Bearer header or cookie, so the proxy
// doesn't gate them. /login + /signup are always public.
const PUBLIC_PATHS = ['/login', '/signup', '/forgot-password', '/reset-password', '/auth', '/api', '/manifest.webmanifest', '/sw.js'];
const PUBLIC_EXACT = new Set(['/']);
let loggedVersion = false;

export async function proxy(request: NextRequest) {
  const host = request.headers.get('host') ?? '';

  // Redirect www → non-www before touching auth.
  if (host.startsWith('www.')) {
    const url = request.nextUrl.clone();
    url.host = host.replace(/^www\./, '');
    return NextResponse.redirect(url, 301);
  }

  let response = NextResponse.next({ request });
  const version = getB1dzVersion();

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (toSet) => {
          for (const { name, value } of toSet) request.cookies.set(name, value);
          response = NextResponse.next({ request });
          for (const { name, value, options } of toSet) response.cookies.set(name, value, options);
        },
      },
    },
  );

  const { data: { user } } = await supabase.auth.getUser();

  const path = request.nextUrl.pathname;
  const isPublic = PUBLIC_EXACT.has(path) || PUBLIC_PATHS.some((p) => path === p || path.startsWith(p + '/'));

  if (!user && !isPublic) {
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    url.searchParams.set('next', path);
    const redirect = NextResponse.redirect(url);
    redirect.headers.set('x-b1dz-version', version);
    return redirect;
  }

  response.headers.set('x-b1dz-version', version);
  if (!loggedVersion) {
    console.log(`[api] version ${version}`);
    loggedVersion = true;
  }
  return response;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)'],
};
