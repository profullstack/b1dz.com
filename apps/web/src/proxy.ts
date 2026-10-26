import { gate } from "@/lib/crawl-gateway";
/**
 * Auth proxy — redirects www → apex, refreshes the Supabase session on every
 * request, and gates non-public routes. Lifted from the official @supabase/ssr docs.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { getB1dzVersion } from '@b1dz/core';
import { createServerClient } from '@supabase/ssr';

// API routes self-authenticate via Bearer header or cookie, so the proxy
// doesn't gate them. /login + /signup are always public.
const PUBLIC_PATHS = [
  '/login', '/signup', '/forgot-password', '/reset-password', '/auth', '/api',
  '/manifest.webmanifest', '/sw.js',
  // Crawler / AEO well-known files — must never redirect to /login.
  '/robots.txt', '/sitemap.xml', '/llms.txt', '/llms-full.txt', '/skill.md', '/.well-known',
  // CLI installer: `curl -fsSL https://b1dz.com/install.sh | sh`.
  '/install.sh',
  // Invite landing: /i/<code> must work signed out.
  '/i',
];
const INVITE_PATH = /^\/i\/([A-Za-z0-9-]{12,40})\/?$/;
const INVITE_COOKIE = 'b1dz_invite'; // = INVITE_COOKIE in lib/credits.ts (kept local: the proxy stays Edge-safe)
const REF_COOKIE = 'referral_code'; // = REF_COOKIE in @profullstack/affiliates
const PUBLIC_EXACT = new Set(['/']);
let loggedVersion = false;

export async function proxy(request: NextRequest) {
  // Crawl gateway first: AI training crawlers get 402 Payment Required (or the
  // sales page at /crawl) unless they present a paid pass. People, Googlebot
  // and retrieval crawlers fall through to everything below.
  // An invite link is for a person someone chose; it never meets the gate.
  const inviteMatch = INVITE_PATH.exec(request.nextUrl.pathname);
  if (!inviteMatch) {
    const answer = await gate(request);
    if (answer) return answer;
  }

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

  // Remember an invite through signup, and a ?ref= affiliate code (first
  // touch: an existing referral cookie is never overwritten).
  if (inviteMatch) {
    response.cookies.set(INVITE_COOKIE, inviteMatch[1], { path: '/', maxAge: 30 * 86400, sameSite: 'lax', secure: true, httpOnly: true });
  }
  const ref = request.nextUrl.searchParams.get('ref');
  if (ref && /^[A-Za-z0-9]{4,32}$/.test(ref) && !request.cookies.get(REF_COOKIE)) {
    response.cookies.set(REF_COOKIE, ref, { path: '/', maxAge: 30 * 86400, sameSite: 'lax', secure: true, httpOnly: true });
  }

  response.headers.set('x-b1dz-version', version);
  if (!loggedVersion) {
    console.log(`[api] version ${version}`);
    loggedVersion = true;
  }
  return response;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|txt|xml|md|json|webmanifest|ico|woff2?|sh)$).*)'],
};
