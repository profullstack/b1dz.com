import { NextResponse, type NextRequest } from 'next/server';
import { createServerSupabase } from '@/lib/supabase';
import { OAUTH_COOKIE, OAUTH_COOKIE_MAX_AGE, OAUTH_COOKIE_PATH, coinpayConfig, startAuth } from '@/lib/coinpay-signin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// GET /api/v1/coinpay/oauth/start?mode=login|connect&next=/path
// 302 to CoinPay authorize with PKCE S256, state and nonce; those ride in a
// short-lived httpOnly cookie scoped to the OAuth routes. mode=connect links
// CoinPay to the signed-in account (Settings) and needs a session.
export async function GET(req: NextRequest) {
  const cfg = coinpayConfig();
  if (!cfg) return NextResponse.redirect(new URL('/login?error=' + encodeURIComponent('Sign in with CoinPay is not available right now.'), req.nextUrl.origin), 302);
  const sp = req.nextUrl.searchParams;
  const mode = sp.get('mode') === 'connect' ? 'connect' : 'login';
  if (mode === 'connect') {
    const supabase = await createServerSupabase();
    const { data } = await supabase.auth.getUser();
    if (!data.user) return NextResponse.redirect(new URL('/login?next=/settings', cfg.siteUrl), 302);
  }
  const { url, cookie } = startAuth(cfg, mode, sp.get('next'));
  const res = NextResponse.redirect(url, 302);
  res.cookies.set(OAUTH_COOKIE, cookie, {
    httpOnly: true,
    secure: cfg.siteUrl.startsWith('https://'),
    sameSite: 'lax',
    path: OAUTH_COOKIE_PATH,
    maxAge: OAUTH_COOKIE_MAX_AGE,
  });
  res.headers.set('cache-control', 'no-store');
  return res;
}
