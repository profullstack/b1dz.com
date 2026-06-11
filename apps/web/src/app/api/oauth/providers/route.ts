/**
 * GET /api/oauth/providers
 *
 * Tells the settings UI which plugins support OAuth and whether the operator
 * has configured each (client id/secret env present). The UI shows a "Connect"
 * button for supported+configured providers and a disabled hint otherwise.
 */
import type { NextRequest } from 'next/server';
import { authenticate, unauthorized } from '@/lib/api-auth';
import { oauthStatus } from '@/lib/oauth-providers';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const auth = await authenticate(req);
  if (!auth) return unauthorized();
  return Response.json({ providers: oauthStatus() });
}
