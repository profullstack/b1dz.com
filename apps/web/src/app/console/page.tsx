import { redirect } from 'next/navigation';
import Link from 'next/link';
import Image from 'next/image';
import { createServerSupabase } from '@/lib/supabase';
import { ConsoleClient } from './console-client';
import { RenewalBanner } from '@/components/renewal-banner';

export const dynamic = 'force-dynamic';

export default async function ConsolePage() {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login?next=/console');

  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100">
      <nav className="flex items-center justify-between border-b border-zinc-800 bg-zinc-950/95 px-6 py-3">
        <div className="flex items-end gap-3">
          <Link href="/" aria-label="b1dz home" className="inline-flex items-center">
            <Image src="/favicon.svg" alt="b1dz" width={40} height={40} className="block hover:opacity-80 transition" />
          </Link>
          <span className="text-base leading-none pb-1 text-zinc-300">&gt; console</span>
          <Link href="/dashboard" className="text-xs leading-none pb-1 text-zinc-500 hover:text-zinc-300">← summary</Link>
        </div>
        <div className="flex items-center gap-4 text-sm">
          <Link href="/store" className="text-zinc-400 hover:text-zinc-200">Store</Link>
          <Link href="/settings" className="text-zinc-400 hover:text-zinc-200">Settings</Link>
          <span className="text-zinc-400">{user.email}</span>
          <form action="/api/auth/logout" method="POST">
            <button className="text-zinc-500 hover:text-zinc-300">Sign out</button>
          </form>
        </div>
      </nav>
      <RenewalBanner userId={user.id} />
      <ConsoleClient />
    </main>
  );
}
