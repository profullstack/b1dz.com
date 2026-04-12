'use client';
import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import Image from 'next/image';
import { createBrowserSupabase } from '@/lib/supabase';

function LoginForm() {
  const router = useRouter();
  const next = useSearchParams().get('next') || '/dashboard';
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    const supabase = createBrowserSupabase();
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setBusy(false);
    if (error) { setError(error.message); return; }
    router.replace(next);
  }

  return (
    <main className="min-h-screen flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <Link href="/">
            <Image src="/logo.svg" alt="b1dz" width={48} height={48} className="mx-auto mb-3" />
          </Link>
          <h1 className="text-2xl font-bold">Sign in to <span className="bg-gradient-to-r from-orange-400 to-amber-500 bg-clip-text text-transparent">b1dz</span></h1>
          <p className="text-sm text-zinc-400 mt-1">AI Arbitrage Terminal</p>
        </div>
        <form onSubmit={onSubmit} className="space-y-4">
          <div>
            <label className="block text-sm text-zinc-400 mb-1">Email</label>
            <input className="w-full bg-zinc-900 border border-zinc-700 focus:border-orange-500 rounded-lg px-4 py-2.5 outline-none transition"
              type="email" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
          </div>
          <div>
            <label className="block text-sm text-zinc-400 mb-1">Password</label>
            <input className="w-full bg-zinc-900 border border-zinc-700 focus:border-orange-500 rounded-lg px-4 py-2.5 outline-none transition"
              type="password" placeholder="Enter your password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </div>
          {error && <div className="text-red-400 text-sm bg-red-400/10 border border-red-400/20 rounded-lg px-3 py-2">{error}</div>}
          <button className="w-full bg-gradient-to-r from-orange-500 to-amber-500 hover:from-orange-400 hover:to-amber-400 text-black font-semibold rounded-lg px-4 py-2.5 transition disabled:opacity-50"
            disabled={busy} type="submit">{busy ? 'Signing in...' : 'Sign in'}</button>
        </form>
        <p className="text-sm text-zinc-500 mt-6 text-center">
          No account? <Link className="text-orange-400 hover:text-orange-300" href="/signup">Create one</Link>
        </p>
      </div>
    </main>
  );
}

export default function LoginPage() {
  return <Suspense><LoginForm /></Suspense>;
}
