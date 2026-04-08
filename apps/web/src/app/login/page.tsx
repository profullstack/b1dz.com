'use client';
import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { createBrowserSupabase } from '@/lib/supabase';

export default function LoginPage() {
  const router = useRouter();
  const next = useSearchParams().get('next') || '/';
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
    <main className="max-w-sm mx-auto p-6 mt-20">
      <h1 className="text-2xl font-bold mb-1">Sign in</h1>
      <p className="text-sm text-zinc-400 mb-6">b1dz.com</p>
      <form onSubmit={onSubmit} className="space-y-3">
        <input className="w-full bg-zinc-900 border border-zinc-800 rounded px-3 py-2"
          type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        <input className="w-full bg-zinc-900 border border-zinc-800 rounded px-3 py-2"
          type="password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        {error && <div className="text-red-400 text-sm">{error}</div>}
        <button className="w-full bg-emerald-600 hover:bg-emerald-500 rounded px-3 py-2 font-medium disabled:opacity-50"
          disabled={busy} type="submit">{busy ? 'Signing in…' : 'Sign in'}</button>
      </form>
      <p className="text-sm text-zinc-500 mt-4">No account? <Link className="text-emerald-400" href="/signup">Sign up</Link></p>
    </main>
  );
}
