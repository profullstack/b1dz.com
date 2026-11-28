'use client';

import { useEffect, useState } from 'react';
import { browserSupportsWebAuthn, startAuthentication, WebAuthnError } from '@simplewebauthn/browser';

/**
 * "Sign in with a passkey" on /login. Discoverable credentials, so no email is
 * typed: the browser offers the passkeys it holds for b1dz.com. A passkey is
 * added from Settings after signing in some other way.
 */
export function PasskeySigninButton({ next, onError }: { next: string; onError: (msg: string | null) => void }) {
  const [supported, setSupported] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => { setSupported(browserSupportsWebAuthn()); }, []);
  if (!supported) return null;

  const go = async () => {
    setBusy(true);
    onError(null);
    try {
      const o = await fetch('/api/auth/passkey/login/options', { method: 'POST' });
      const ob = await o.json().catch(() => ({}));
      if (!o.ok || !ob.options) throw new Error(ob.error ?? 'Passkey sign-in is unavailable right now.');
      const response = await startAuthentication({ optionsJSON: ob.options });
      const v = await fetch('/api/auth/passkey/login/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ response }),
      });
      const vb = await v.json().catch(() => ({}));
      if (!v.ok || !vb.ok) throw new Error(vb.error ?? 'Passkey sign-in failed.');
      window.location.assign(next);
    } catch (e) {
      // Closing the browser prompt is not an error worth shouting about.
      if (e instanceof WebAuthnError && e.code === 'ERROR_CEREMONY_ABORTED') { setBusy(false); return; }
      if (e instanceof Error && e.name === 'NotAllowedError') { setBusy(false); return; }
      onError(e instanceof Error ? e.message : 'Passkey sign-in failed.');
      setBusy(false);
    }
  };

  return (
    <button
      type="button"
      onClick={go}
      disabled={busy}
      className="mb-4 block w-full rounded-lg border border-zinc-700 bg-zinc-900 px-4 py-2.5 text-center font-semibold text-zinc-100 transition hover:border-orange-500 disabled:opacity-50"
    >
      {busy ? 'Waiting for your passkey...' : 'Sign in with a passkey'}
    </button>
  );
}
