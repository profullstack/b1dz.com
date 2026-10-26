import Link from 'next/link';
import Image from 'next/image';
import type { Metadata } from 'next';
import { createServerSupabase } from '@/lib/supabase';
import { INVITE_BONUS_PRO_DAYS } from '@/lib/credits';
import { AcceptInviteButton } from './accept-button';

// The proxy stores the code in the b1dz_invite cookie on this request, so
// signup (here or on another device via the emailed link) picks it up.
export const dynamic = 'force-dynamic';
export const metadata: Metadata = {
  title: "You're invited to b1dz",
  description: 'Someone invited you to b1dz, the AI arbitrage terminal.',
  robots: { index: false, follow: false },
};

export default async function InviteLanding({ params }: { params: Promise<{ code: string }> }) {
  const { code: raw } = await params;
  const code = decodeURIComponent(raw).toUpperCase();
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();

  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm text-center">
        <Link href="/">
          <Image src="/logo.svg" alt="b1dz" width={48} height={48} className="mx-auto mb-3" />
        </Link>
        <h1 className="text-2xl font-bold">
          You&apos;re invited to <span className="bg-gradient-to-r from-orange-400 to-amber-500 bg-clip-text text-transparent">b1dz</span>
        </h1>
        <p className="mt-2 text-sm text-zinc-400">
          Invites are scarce: each member gets three. Join on this one and you both get {INVITE_BONUS_PRO_DAYS} Pro days once you confirm your email.
        </p>
        <p className="mt-4 font-mono text-sm text-zinc-300">{code}</p>
        <div className="mt-6 space-y-3">
          {user ? (
            <AcceptInviteButton code={code} />
          ) : (
            <>
              <Link
                href="/signup"
                className="block w-full rounded-lg bg-gradient-to-r from-orange-500 to-amber-500 px-4 py-2.5 font-semibold text-black hover:from-orange-400 hover:to-amber-400"
              >
                Create your account
              </Link>
              <p className="text-sm text-zinc-500">
                Already a member? <Link className="text-orange-400 hover:text-orange-300" href="/login?next=/invites">Sign in</Link>
              </p>
            </>
          )}
        </div>
      </div>
    </main>
  );
}
