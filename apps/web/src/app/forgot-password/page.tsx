'use client';
import { useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null); setSent(false);
    try {
      const res = await fetch('/api/auth/reset-password', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error || 'Could not send reset email'); setBusy(false); return; }
      setSent(true);
    } catch {
      setError('Network error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="min-h-screen flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <Link href="/">
            <Image src="/logo.svg" alt="b1dz" width={48} height={48} className="mx-auto mb-3" />
          </Link>
          <h1 className="text-2xl font-bold">Reset your password</h1>
          <p className="text-sm text-zinc-400 mt-1">We’ll email you a secure reset link.</p>
        </div>
        <form onSubmit={onSubmit} className="space-y-4">
          <div>
            <label className="block text-sm text-zinc-400 mb-1">Email</label>
            <input className="w-full bg-zinc-900 border border-zinc-700 focus:border-orange-500 rounded-lg px-4 py-2.5 outline-none transition"
              type="email" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
          </div>
          {error && <div className="text-red-400 text-sm bg-red-400/10 border border-red-400/20 rounded-lg px-3 py-2">{error}</div>}
          {sent && <div className="text-emerald-400 text-sm bg-emerald-400/10 border border-emerald-400/20 rounded-lg px-3 py-2">Check your email for the reset link.</div>}
          <button className="w-full bg-gradient-to-r from-orange-500 to-amber-500 hover:from-orange-400 hover:to-amber-400 text-black font-semibold rounded-lg px-4 py-2.5 transition disabled:opacity-50"
            disabled={busy} type="submit">{busy ? 'Sending...' : 'Send reset link'}</button>
        </form>
        <p className="text-sm text-zinc-500 mt-6 text-center">
          Remembered it? <Link className="text-orange-400 hover:text-orange-300" href="/login">Sign in</Link>
        </p>
      </div>
    </main>
  );
}
