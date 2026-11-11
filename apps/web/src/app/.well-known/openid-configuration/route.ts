import { CORS_HEADERS, openidConfiguration } from '@/lib/mcp-oauth';

export const dynamic = 'force-dynamic';

// For MCP clients that only look for OpenID discovery. No id_token is issued.
export function GET() {
  return Response.json(openidConfiguration(), {
    headers: { ...CORS_HEADERS, 'cache-control': 'public, max-age=3600' },
  });
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}
