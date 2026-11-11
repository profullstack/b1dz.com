import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { checkAuthorize, type AuthorizeParams } from '@/lib/mcp-oauth';
import { createAdminSupabase, createServerSupabase } from '@/lib/supabase';
import ConsentForm from './consent-form';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Connect an app - b1dz',
  description: 'Allow an AI app (Claude, ChatGPT, ...) to use your b1dz account through the b1dz MCP server.',
  robots: { index: false, follow: false },
};

const FIELDS = ['response_type', 'client_id', 'redirect_uri', 'code_challenge', 'code_challenge_method', 'state', 'scope', 'resource'] as const;

/**
 * OAuth 2.1 authorization endpoint for the MCP server at /api/agent/mcp. Not
 * signed in: round trip through /login (password or CoinPay) and back. Signed
 * in: name the client, let the user pick read-only or a capped trading budget,
 * and post the decision to /api/oauth/authorize.
 */
export default async function OAuthAuthorizePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const raw = await searchParams;
  const params: Record<string, string> = {};
  for (const f of FIELDS) {
    const v = raw[f];
    if (typeof v === 'string') params[f] = v;
  }
  const check = await checkAuthorize(createAdminSupabase(), params as AuthorizeParams);
  if (!check.ok) {
    if ('redirect' in check) redirect(check.redirect);
    return (
      <main className="min-h-screen flex items-center justify-center px-4">
        <div className="w-full max-w-md space-y-4 text-center">
          <h1 className="text-xl font-semibold">This connection request cannot be used</h1>
          <p className="text-zinc-400 text-sm">{check.description}</p>
        </div>
      </main>
    );
  }

  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect(`/login?next=${encodeURIComponent(`/oauth/authorize?${new URLSearchParams(params).toString()}`)}`);

  return (
    <main className="min-h-screen flex items-center justify-center px-4 py-10">
      <ConsentForm
        params={params}
        clientName={check.client.client_name}
        clientUri={check.client.client_uri}
        redirectHost={new URL(check.redirectUri).host}
        account={user.email ?? user.id}
      />
    </main>
  );
}
