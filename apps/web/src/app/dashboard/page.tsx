import { createServerSupabase } from '@/lib/supabase';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import Image from 'next/image';
import { TradingChart } from './trading-chart';
import { DashboardSummary } from './dashboard-summary';

export const dynamic = 'force-dynamic';

export default async function DashboardPage() {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login?next=/dashboard');

  return (
    <main className="min-h-screen">
      <nav className="flex items-center justify-between max-w-6xl mx-auto px-6 py-4 border-b border-zinc-800">
        <div className="flex items-center gap-2">
          <Image src="/favicon.svg" alt="b1dz" width={28} height={28} />
          <span className="text-lg font-bold bg-gradient-to-r from-orange-400 to-amber-500 bg-clip-text text-transparent">b1dz</span>
        </div>
        <div className="flex items-center gap-4">
          <Link href="/console" className="text-sm text-orange-300 hover:text-orange-200">Console →</Link>
          <Link href="/settings" className="text-sm text-zinc-400 hover:text-zinc-200">Settings</Link>
          <span className="text-sm text-zinc-400">{user.email}</span>
          <form action="/api/auth/logout" method="POST">
            <button className="text-sm text-zinc-500 hover:text-zinc-300 transition">Sign out</button>
          </form>
        </div>
      </nav>

      <div className="max-w-6xl mx-auto px-6 py-8">
        <h1 className="text-2xl font-bold mb-2">Dashboard</h1>
        <p className="text-zinc-400 mb-8">Realtime summary of daemon PnL, positions, and arb pipeline. Open the Console for the full operator view.</p>

        <div className="space-y-8">
          <DashboardSummary />
          <TradingChart />
        </div>
      </div>
    </main>
  );
}
