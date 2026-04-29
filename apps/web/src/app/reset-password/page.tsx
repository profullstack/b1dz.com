'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import Image from 'next/image';

export default function ResetPasswordPage() {
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (password !== confirmPassword) { setError('Passwords do not match'); return; }
    setBusy(true);
    try {
      const res = await fetch('/api/auth/update-password', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error || 'Could not update password'); setBusy(false); return; }
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
          <h1 className="text-2xl font-bold">Choose a new password</h1>
          <p className="text-sm text-zinc-400 mt-1">Use at least 8 characters.</p>
        </div>
        <form onSubmit={onSubmit} className="space-y-4">
          <div>
            <label className="block text-sm text-zinc-400 mb-1">New password</label>
            <input className="w-full bg-zinc-900 border border-zinc-700 focus:border-orange-500 rounded-lg px-4 py-2.5 outline-none transition"
              type="password" placeholder="8+ characters" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} autoFocus />
          </div>
          <div>
            <label className="block text-sm text-zinc-400 mb-1">Confirm password</label>
            <input className="w-full bg-zinc-900 border border-zinc-700 focus:border-orange-500 rounded-lg px-4 py-2.5 outline-none transition"
              type="password" placeholder="Repeat new password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} required minLength={8} />
          </div>
          {error && <div className="text-red-400 text-sm bg-red-400/10 border border-red-400/20 rounded-lg px-3 py-2">{error}</div>}
          <button className="w-full bg-gradient-to-r from-orange-500 to-amber-500 hover:from-orange-400 hover:to-amber-400 text-black font-semibold rounded-lg px-4 py-2.5 transition disabled:opacity-50"
            disabled={busy} type="submit">{busy ? 'Updating...' : 'Update password'}</button>
        </form>
      </div>
    </main>
  );
}
