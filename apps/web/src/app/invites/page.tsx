import { redirect } from 'next/navigation';
import Link from 'next/link';
import Image from 'next/image';
import type { Metadata } from 'next';
import { createServerSupabase } from '@/lib/supabase';
import { SignOutForm } from '@/components/sign-out-form';
import { RedeemCodeCard } from '@/components/redeem-code-card';
import { InvitesClient } from './invites-client';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Invites | b1dz', robots: { index: false } };

export default async function InvitesPage() {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login?next=/invites');

  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100">
      <nav className="flex items-center justify-between border-b border-zinc-800 bg-zinc-950/95 px-6 py-3">
        <div className="flex items-center gap-3">
          <Link href="/dashboard" className="flex items-center gap-2">
            <Image src="/logo.svg" alt="b1dz" width={24} height={24} />
            <span className="text-base font-bold bg-gradient-to-r from-orange-400 to-amber-500 bg-clip-text text-transparent">b1dz invites</span>
          </Link>
          <Link href="/dashboard" className="text-xs text-zinc-500 hover:text-zinc-300">summary</Link>
          <Link href="/settings" className="text-xs text-zinc-500 hover:text-zinc-300">settings</Link>
        </div>
        <div className="flex items-center gap-4 text-sm">
          <span className="hidden text-zinc-400 sm:inline">{user.email}</span>
          <SignOutForm className="text-zinc-500 hover:text-zinc-300" />
        </div>
      </nav>
      <div className="mx-auto max-w-3xl space-y-6 px-4 py-6 sm:px-6">
        <InvitesClient />
        <RedeemCodeCard />
      </div>
    </main>
  );
}
