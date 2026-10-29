import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { createAdminSupabase } from '@/lib/supabase';
import {
  OAUTH_COOKIE,
  OAUTH_COOKIE_PATH,
  coinpayConfig,
  decodePending,
  fetchCoinpayClaims,
  mintMagicLinkHash,
  resolveCoinpayUser,
  sameState,
  supabaseCoinpayStore,
} from '@/lib/coinpay-signin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// GET /api/v1/coinpay/oauth/callback?code&state
// Checks state (cookie) and nonce (id_token), exchanges the code with PKCE and
// the client secret, resolves the b1dz user BY CoinPay sub
// (lib/coinpay-signin.ts), then either links (mode=connect, signed in) or
// signs in by redeeming a server-minted magic-link hash for that user's own
// email, which sets the normal Supabase session cookies on this response.
export async function GET(req: NextRequest) {
  const cfg = coinpayConfig();
  const origin = cfg?.siteUrl ?? req.nextUrl.origin;
  const pending = decodePending(req.cookies.get(OAUTH_COOKIE)?.value);
  const res = NextResponse.redirect(new URL('/login', origin), 302);
  const back = (path: string, error?: string) => {
    const url = new URL(path, origin);
    if (error) url.searchParams.set('error', error);
    res.headers.set('location', url.toString());
    res.cookies.set(OAUTH_COOKIE, '', { path: OAUTH_COOKIE_PATH, maxAge: 0 });
    res.headers.set('cache-control', 'no-store');
    return res;
  };
  if (!cfg) return back('/login', 'Sign in with CoinPay is not available right now.');
  const failPath = pending?.mode === 'connect' ? '/settings' : '/login';
  const sp = req.nextUrl.searchParams;

  if (!pending) return back('/login', 'CoinPay sign-in expired. Try again.');
  if (!sameState(pending.state, sp.get('state'))) return back(failPath, 'CoinPay sign-in failed: state mismatch.');
  if (sp.get('error')) return back(failPath, 'CoinPay sign-in was cancelled.');
  const code = sp.get('code');
  if (!code) return back(failPath, 'CoinPay sign-in failed: no code.');

  const claims = await fetchCoinpayClaims(cfg, { code, verifier: pending.verifier, nonce: pending.nonce });
  if (!claims.ok) {
    console.error('[coinpay-signin]', claims.error);
    return back(failPath, 'CoinPay sign-in failed. Try again.');
  }

  // The cookie-bound client: reads the current session, and writes the new
  // one straight onto the redirect response.
  const supabase = createServerClient(
    (process.env as Record<string, string | undefined>)['NEXT_PUBLIC_SUPABASE_URL']!,
    (process.env as Record<string, string | undefined>)['NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY']!,
    {
      cookies: {
        getAll: () => req.cookies.getAll(),
        setAll: (toSet) => toSet.forEach(({ name, value, options }) => res.cookies.set(name, value, options)),
      },
    },
  );
  const { data: cur } = await supabase.auth.getUser();
  const admin = createAdminSupabase();
  let resolved;
  try {
    resolved = await resolveCoinpayUser({ mode: pending.mode, currentUserId: cur.user?.id ?? null, claims: claims.claims }, supabaseCoinpayStore(admin));
  } catch (e) {
    console.error('[coinpay-signin] resolve', e instanceof Error ? e.message : e);
    return back(failPath, 'CoinPay sign-in failed. Try again.');
  }
  if (!resolved.ok) return back(failPath, resolved.error);
  if (pending.mode === 'connect') return back(`${pending.next}${pending.next.includes('?') ? '&' : '?'}coinpay=connected`);

  // Already signed in as that very user: nothing to mint.
  if (cur.user?.id === resolved.userId) return back(pending.next);
  if (cur.user) await supabase.auth.signOut({ scope: 'local' }).catch(() => {});
  const minted = await mintMagicLinkHash(admin, resolved.userId);
  if (!minted.ok) return back('/login', minted.error);
  const { error } = await supabase.auth.verifyOtp({ type: 'magiclink', token_hash: minted.tokenHash });
  if (error) {
    console.error('[coinpay-signin] verifyOtp', error.message);
    return back('/login', 'Could not start your session. Try again.');
  }
  return back(pending.next);
}
