/**
 * GET /api/v1/logicsrc/grant/start?keys=ANTHROPIC_API_KEY,OPENAI_API_KEY&next=/settings
 *
 * Signed in: records a grant request and sends the person to logicsrc to
 * approve it (303). Signed out: to /login. b1dz only asks for API keys, never
 * wallet or signing keys (see lib/logicsrc-keys.ts).
 */
import { NextResponse, type NextRequest } from 'next/server';
import { parseKeyNames, KeyGrantError } from '@profullstack/key-grants';
import { authenticate } from '@/lib/api-auth';
import { keyGrants } from '@/lib/logicsrc-grants';
import { isGrantableKey } from '@/lib/logicsrc-keys';

export const dynamic = 'force-dynamic';

const back = (code: string) => new Response(null, { status: 303, headers: { location: `/settings?logicsrc=${code}` } });

export async function GET(req: NextRequest) {
  const kg = keyGrants();
  const url = new URL(req.url);
  const auth = await authenticate(req);
  if (!auth) return NextResponse.redirect(new URL('/login?next=/settings', kg.origin), 303);

  const keys = url.searchParams.get('keys');
  try {
    if (!parseKeyNames(keys ?? '').every(isGrantableKey)) return back('bad_key');
  } catch (e) {
    if (e instanceof KeyGrantError) return back(e.code);
    throw e;
  }
  return kg.startResponse({ userId: auth.userId, keys: keys ?? '', next: url.searchParams.get('next') ?? '/settings', errorPath: '/settings' });
}
