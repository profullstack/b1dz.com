'use client';

import Link from 'next/link';
import { useState } from 'react';

export function AcceptInviteButton({ code }: { code: string }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const onClick = async () => {
    setBusy(true);
    try {
      const r = await fetch('/api/invites/accept', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      const b = await r.json().catch(() => ({}));
      setMsg(r.ok ? { ok: true, text: 'Invite accepted.' } : { ok: false, text: b.error ?? 'Could not accept this invite.' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      {!msg?.ok && (
        <button
          onClick={onClick}
          disabled={busy}
          className="w-full rounded-lg bg-gradient-to-r from-orange-500 to-amber-500 px-4 py-2.5 font-semibold text-black disabled:opacity-50"
        >
          {busy ? 'Accepting…' : 'Accept invite'}
        </button>
      )}
      {msg && <p className={`text-sm ${msg.ok ? 'text-emerald-300' : 'text-red-300'}`}>{msg.text}</p>}
      <Link href="/invites" className="block text-sm text-orange-400 hover:text-orange-300">Go to your invites</Link>
    </div>
  );
}
