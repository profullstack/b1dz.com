'use client';

import { useCallback, useEffect, useState } from 'react';
import { browserSupportsWebAuthn, startRegistration, WebAuthnError } from '@simplewebauthn/browser';

type Passkey = { id: string; name: string; device_type: string; backed_up: boolean; created_at?: string; last_used_at?: string | null };

const day = (iso?: string | null) => (iso ? new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : null);

function guessName(): string {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  const os = /iPhone|iPad/.test(ua) ? 'iPhone/iPad' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'This device';
  const br = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : '';
  return br ? `${br} on ${os}` : os;
}

/** Settings -> Passkeys: sign in with Face ID, Touch ID, Windows Hello or a security key. */
export function PasskeysCard() {
  const [supported, setSupported] = useState(true);
  const [items, setItems] = useState<Passkey[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    const r = await fetch('/api/auth/passkey', { cache: 'no-store' }).catch(() => null);
    const b = r ? await r.json().catch(() => ({})) : {};
    setItems(Array.isArray(b.passkeys) ? b.passkeys : []);
  }, []);

  useEffect(() => {
    setSupported(browserSupportsWebAuthn());
    void load();
  }, [load]);

  const add = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const o = await fetch('/api/auth/passkey/register/options', { method: 'POST' });
      const ob = await o.json().catch(() => ({}));
      if (!o.ok || !ob.options) throw new Error(ob.error ?? 'Could not start passkey setup.');
      const response = await startRegistration({ optionsJSON: ob.options });
      const v = await fetch('/api/auth/passkey/register/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ response, name: guessName() }),
      });
      const vb = await v.json().catch(() => ({}));
      if (!v.ok || !vb.ok) throw new Error(vb.error ?? 'Could not save the passkey.');
      setMsg({ ok: true, text: 'Passkey added. Next time, choose "Sign in with a passkey".' });
      await load();
    } catch (e) {
      if (e instanceof WebAuthnError && e.code === 'ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED') setMsg({ ok: false, text: 'This device already has a b1dz passkey.' });
      else if (!(e instanceof Error && (e.name === 'NotAllowedError' || (e instanceof WebAuthnError && e.code === 'ERROR_CEREMONY_ABORTED'))))
        setMsg({ ok: false, text: e instanceof Error ? e.message : 'Could not add a passkey.' });
    } finally {
      setBusy(false);
    }
  };

  const call = async (method: 'PATCH' | 'DELETE', body: object, done: string) => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await fetch('/api/auth/passkey', { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const b = await r.json().catch(() => ({}));
      if (!r.ok || !b.ok) throw new Error(b.error ?? 'Request failed.');
      setMsg({ ok: true, text: done });
      await load();
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : 'Request failed.' });
    } finally {
      setBusy(false);
    }
  };

  const rename = (p: Passkey) => {
    const name = window.prompt('Name this passkey', p.name);
    if (name && name.trim() && name.trim() !== p.name) void call('PATCH', { id: p.id, name: name.trim() }, 'Passkey renamed.');
  };
  const remove = (p: Passkey) => {
    if (window.confirm(`Remove "${p.name}"? It will no longer sign you in to b1dz.`)) void call('DELETE', { id: p.id }, 'Passkey removed.');
  };

  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-zinc-200">Passkeys</h2>
        {supported && (
          <button onClick={add} disabled={busy} className="text-xs text-orange-400 hover:text-orange-300 disabled:opacity-50">
            {busy ? 'Working...' : 'Add a passkey'}
          </button>
        )}
      </div>
      <p className="mt-1 text-xs text-zinc-400">
        Sign in with Face ID, Touch ID, Windows Hello, your phone or a security key. No password, nothing to phish.
      </p>
      {!supported && <p className="mt-2 text-xs text-zinc-500">This browser does not support passkeys.</p>}
      {items && items.length > 0 && (
        <ul className="mt-3 divide-y divide-zinc-800 text-xs">
          {items.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <div>
                <span className="text-zinc-200">{p.name}</span>
                {p.backed_up && <span className="ml-2 rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400">synced</span>}
                <div className="text-zinc-500">
                  Added {day(p.created_at) ?? 'recently'}
                  {p.last_used_at ? ` · last used ${day(p.last_used_at)}` : ' · never used'}
                </div>
              </div>
              <div className="flex gap-3">
                <button onClick={() => rename(p)} disabled={busy} className="text-zinc-400 hover:text-zinc-200 disabled:opacity-50">Rename</button>
                <button onClick={() => remove(p)} disabled={busy} className="text-orange-400 hover:text-orange-300 disabled:opacity-50">Remove</button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {items && items.length === 0 && supported && <p className="mt-2 text-xs text-zinc-500">No passkeys yet.</p>}
      {msg && <p className={`mt-2 text-xs ${msg.ok ? 'text-green-400' : 'text-red-400'}`}>{msg.text}</p>}
    </section>
  );
}
