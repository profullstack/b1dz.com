/**
 * Next.js edge middleware — refreshes the Supabase session on every request
 * so the access token stays valid without requiring the browser to have a
 * running Supabase client. Without this, API route calls start returning 401
 * after the 1-hour access token expires, making the console appear offline.
 */
import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

export async function middleware(request: NextRequest) {
  const response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (toSet) => {
          for (const { name, value, options } of toSet) {
            request.cookies.set(name, value);
            response.cookies.set(name, value, options);
          }
        },
      },
    },
  );

  // Calling getUser() triggers a token refresh when the access token is
  // expired and the refresh token is still valid. The refreshed token is
  // written back to the response cookies via setAll above.
  await supabase.auth.getUser();

  return response;
}

export const config = {
  matcher: [
    // Run on all paths except Next.js internals and static assets
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};
