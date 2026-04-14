import { createServerSupabase } from '@/lib/supabase';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import Image from 'next/image';

export default async function DashboardPage() {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login?next=/dashboard');

  return (
    <main className="min-h-screen">
      <nav className="flex items-center justify-between max-w-6xl mx-auto px-6 py-4 border-b border-zinc-800">
        <div className="flex items-center gap-2">
          <Image src="/logo.svg" alt="b1dz" width={28} height={28} />
          <span className="text-lg font-bold bg-gradient-to-r from-orange-400 to-amber-500 bg-clip-text text-transparent">b1dz</span>
        </div>
        <div className="flex items-center gap-4">
          <span className="text-sm text-zinc-400">{user.email}</span>
          <form action="/api/auth/logout" method="POST">
            <button className="text-sm text-zinc-500 hover:text-zinc-300 transition">Sign out</button>
          </form>
        </div>
      </nav>

      <div className="max-w-6xl mx-auto px-6 py-8">
        <h1 className="text-2xl font-bold mb-2">Dashboard</h1>
        <p className="text-zinc-400 mb-8">Web dashboard coming soon. Use the TUI for real-time trading:</p>

        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6 max-w-lg">
          <h2 className="text-lg font-semibold mb-3">Quick start</h2>
          <div className="space-y-3 text-sm">
            <div className="bg-zinc-950 rounded-lg p-3 font-mono text-zinc-300">
              <div className="text-zinc-500 mb-1"># Install the CLI</div>
              <div>npm i -g @b1dz/cli</div>
            </div>
            <div className="bg-zinc-950 rounded-lg p-3 font-mono text-zinc-300">
              <div className="text-zinc-500 mb-1"># Login</div>
              <div>b1dz login</div>
            </div>
            <div className="bg-zinc-950 rounded-lg p-3 font-mono text-zinc-300">
              <div className="text-zinc-500 mb-1"># Launch the trading terminal</div>
              <div>b1dz tui</div>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
