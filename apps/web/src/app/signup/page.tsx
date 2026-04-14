'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import Image from 'next/image';

export default function SignupPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const res = await fetch('/api/auth/signup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error || 'Signup failed'); setBusy(false); return; }
      router.replace('/dashboard');
    } catch {
      setError('Network error'); setBusy(false);
    }
  }

  return (
    <main className="min-h-screen flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <Link href="/">
            <Image src="/logo.svg" alt="b1dz" width={48} height={48} className="mx-auto mb-3" />
          </Link>
          <h1 className="text-2xl font-bold">Create your <span className="bg-gradient-to-r from-orange-400 to-amber-500 bg-clip-text text-transparent">b1dz</span> account</h1>
          <p className="text-sm text-zinc-400 mt-1">Start trading in minutes</p>
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
              type="password" placeholder="8+ characters" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} />
          </div>
          {error && <div className="text-red-400 text-sm bg-red-400/10 border border-red-400/20 rounded-lg px-3 py-2">{error}</div>}
          <button className="w-full bg-gradient-to-r from-orange-500 to-amber-500 hover:from-orange-400 hover:to-amber-400 text-black font-semibold rounded-lg px-4 py-2.5 transition disabled:opacity-50"
            disabled={busy} type="submit">{busy ? 'Creating account...' : 'Create account'}</button>
        </form>
        <p className="text-sm text-zinc-500 mt-6 text-center">
          Already have an account? <Link className="text-orange-400 hover:text-orange-300" href="/login">Sign in</Link>
        </p>
      </div>
    </main>
  );
}
