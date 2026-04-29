import { redirect } from 'next/navigation';
import Link from 'next/link';
import Image from 'next/image';
import { createServerSupabase } from '@/lib/supabase';
import { ConsoleClient } from './console-client';

export const dynamic = 'force-dynamic';

export default async function ConsolePage() {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login?next=/console');

  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100">
      <nav className="flex items-center justify-between border-b border-zinc-800 bg-zinc-950/95 px-6 py-3">
        <div className="flex items-center gap-3">
          <Link href="/dashboard" className="flex items-center gap-2">
            <Image src="/logo.svg" alt="b1dz" width={24} height={24} />
            <span className="text-base font-bold bg-gradient-to-r from-orange-400 to-amber-500 bg-clip-text text-transparent">b1dz console</span>
          </Link>
          <Link href="/dashboard" className="text-xs text-zinc-500 hover:text-zinc-300">← summary</Link>
        </div>
        <div className="flex items-center gap-4 text-sm">
          <span className="text-zinc-400">{user.email}</span>
          <form action="/api/auth/logout" method="POST">
            <button className="text-zinc-500 hover:text-zinc-300">Sign out</button>
          </form>
        </div>
      </nav>
      <ConsoleClient />
    </main>
  );
}
