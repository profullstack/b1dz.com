'use client';

/**
 * Passphrase vault + trading-session controls.
 *
 * Your exchange keys, wallet private keys and OAuth tokens are sealed in this
 * browser under a key derived from your passphrase. b1dz stores only
 * ciphertext. The trading daemon can use them only while you have unlocked a
 * trading session; it then holds the data key in memory until the session
 * expires, you press Lock, or the daemon restarts.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  bytesToBase64,
  createSeal,
  openInbox,
  rewrapSeal,
  sealSecrets,
  unlockSeal,
  unlockSealWithRecovery,
  unsealSecrets,
  wipe,
  MIN_PASSPHRASE_LENGTH,
  UNLOCK_DEFAULT_TTL_SECONDS,
} from '@b1dz/core/sealed-secrets';
import type { SettingsResponse, VaultKey } from './shared';

const TTL_OPTIONS: { label: string; seconds: number }[] = [
  { label: '1 hour', seconds: 3600 },
  { label: '8 hours', seconds: UNLOCK_DEFAULT_TTL_SECONDS },
  { label: '24 hours', seconds: 86400 },
  { label: '3 days', seconds: 3 * 86400 },
  { label: '7 days (max)', seconds: 7 * 86400 },
];

interface SessionStatus { unlocked: boolean; expiresAt: string | null; reachable: boolean }

async function putSettings(body: Record<string, unknown>): Promise<SettingsResponse> {
  const res = await fetch('/api/settings', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`save failed (${res.status}): ${t.slice(0, 200)}`);
  }
  return (await res.json()) as SettingsResponse;
}

const input = 'mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-orange-500';
const btn = 'rounded-lg bg-gradient-to-r from-orange-500 to-amber-500 px-4 py-2 text-sm font-semibold text-black hover:from-orange-400 hover:to-amber-400 disabled:opacity-50';
const btnGhost = 'rounded-lg border border-zinc-700 px-3 py-2 text-sm text-zinc-300 hover:border-zinc-500 disabled:opacity-50';

export function VaultPanel({
  data,
  vault,
  onSaved,
  onVault,
}: {
  data: SettingsResponse;
  vault: VaultKey | null;
  onSaved: (next: SettingsResponse) => void;
  onVault: (v: VaultKey | null) => void;
}) {
  const [pass, setPass] = useState('');
  const [pass2, setPass2] = useState('');
  const [useRecovery, setUseRecovery] = useState(false);
  const [recoveryShown, setRecoveryShown] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [changing, setChanging] = useState(false);
  const [ttl, setTtl] = useState(UNLOCK_DEFAULT_TTL_SECONDS);
  const [alsoTrading, setAlsoTrading] = useState(true);
  const [session, setSession] = useState<SessionStatus | null>(null);

  const refreshSession = useCallback(async () => {
    try {
      const res = await fetch('/api/daemon/session', { cache: 'no-store' });
      if (res.ok) setSession((await res.json()) as SessionStatus);
    } catch { /* shown as unknown */ }
  }, []);

  useEffect(() => {
    if (!data.seal) return;
    void refreshSession();
    const t = setInterval(() => { void refreshSession(); }, 30_000);
    return () => clearInterval(t);
  }, [data.seal, refreshSession]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setErr(null);
    try { await fn(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  const unlockTrading = async (key: VaultKey, seconds: number) => {
    const res = await fetch('/api/daemon/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dataKey: bytesToBase64(key.dek), ttlSeconds: seconds }),
    });
    const body = await res.json().catch(() => ({})) as { error?: string };
    if (!res.ok) throw new Error(body.error ?? `unlock failed (${res.status})`);
    await refreshSession();
  };

  const lockTrading = () => run(async () => {
    await fetch('/api/daemon/session', { method: 'DELETE' });
    await refreshSession();
  });

  const checkNewPass = () => {
    if (pass.length < MIN_PASSPHRASE_LENGTH) throw new Error(`passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters`);
    if (pass !== pass2) throw new Error('passphrases do not match');
  };

  /** First setup, or legacy migration (re-seal the old server-key secrets). */
  const createVault = () => run(async () => {
    checkNewPass();
    let secret: Record<string, string> = {};
    if (data.legacy.pending && data.legacy.migrationOpen) {
      const res = await fetch('/api/settings/legacy-migrate', { method: 'POST' });
      const body = await res.json().catch(() => ({})) as { secret?: Record<string, string>; error?: string };
      if (!res.ok) throw new Error(body.error ?? `migration failed (${res.status})`);
      secret = body.secret ?? {};
    }
    const created = await createSeal(pass, data.userId);
    const put: Record<string, unknown> = { seal: created.seal };
    if (Object.keys(secret).length > 0) put.cipher = await sealSecrets(created.dek, secret, data.userId);
    else if (data.legacy.pending) put.cipher = null;
    secret = {};
    const next = await putSettings(put);
    onSaved(next);
    onVault({ dek: created.dek, userId: data.userId });
    setRecoveryShown(created.recoveryKey);
    setPass(''); setPass2('');
  });

  const unlockVault = () => run(async () => {
    if (!data.seal) return;
    const dek = useRecovery
      ? await unlockSealWithRecovery(data.seal, pass, data.userId)
      : await unlockSeal(data.seal, pass, data.userId);
    setPass('');
    const key: VaultKey = { dek, userId: data.userId };
    // Merge OAuth tokens the server sealed to this account's inbox.
    if (data.inbox.length > 0) {
      const { patch, consumed } = await openInbox(dek, data.seal, data.inbox, data.userId);
      if (consumed.length > 0) {
        const current = data.cipher ? await unsealSecrets(dek, data.cipher, data.userId) : {};
        const cipher = await sealSecrets(dek, { ...current, ...patch }, data.userId);
        onSaved(await putSettings({ cipher, inboxConsumed: consumed }));
      }
    }
    onVault(key);
    if (alsoTrading) await unlockTrading(key, ttl);
  });

  const changePassphrase = () => run(async () => {
    if (!vault || !data.seal) throw new Error('unlock first');
    checkNewPass();
    const seal = await rewrapSeal(vault.dek, data.seal, pass, data.userId);
    onSaved(await putSettings({ seal }));
    setPass(''); setPass2(''); setChanging(false);
  });

  const forget = () => {
    if (vault) wipe(vault.dek);
    onVault(null);
  };

  const lossCopy = (
    <p className="text-[11px] text-zinc-500">
      b1dz never sees your passphrase and cannot reset it. If you lose both your passphrase and your recovery key, your saved keys are gone and you will need to re-enter them.
    </p>
  );

  if (recoveryShown) {
    return (
      <section className="space-y-3 rounded-2xl border border-emerald-500/40 bg-emerald-500/5 p-5">
        <h2 className="text-lg font-semibold text-emerald-200">Save your recovery key</h2>
        <p className="text-sm text-zinc-300">This is shown once. It unlocks your vault if you forget your passphrase. Store it in a password manager or on paper.</p>
        <code className="block select-all break-all rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-3 font-mono text-sm text-zinc-100">{recoveryShown}</code>
        {lossCopy}
        <button className={btn} onClick={() => setRecoveryShown(null)}>I saved it</button>
      </section>
    );
  }

  if (!data.seal) {
    const migrating = data.legacy.pending && data.legacy.migrationOpen;
    return (
      <section className="space-y-3 rounded-2xl border border-amber-500/40 bg-amber-500/5 p-5">
        <h2 className="text-lg font-semibold text-amber-200">
          {migrating ? 'Move your keys under your own passphrase' : 'Set a vault passphrase'}
        </h2>
        <p className="text-sm text-zinc-300">
          {migrating
            ? 'Your saved keys are still encrypted with a b1dz server key. Choose a passphrase: your browser re-seals them under a key only you hold, and the old copy is overwritten. Trading stays paused until you do.'
            : data.legacy.pending
              ? 'Your old server-encrypted keys can no longer be migrated. Set a passphrase, then re-enter your keys.'
              : 'Exchange keys, wallet keys and broker tokens are sealed in your browser under this passphrase. b1dz stores only ciphertext.'}
        </p>
        <label className="block text-xs uppercase tracking-wider text-zinc-400">Passphrase
          <input type="password" autoComplete="new-password" className={input} value={pass} onChange={(e) => setPass(e.target.value)} />
        </label>
        <label className="block text-xs uppercase tracking-wider text-zinc-400">Confirm
          <input type="password" autoComplete="new-password" className={input} value={pass2} onChange={(e) => setPass2(e.target.value)} />
        </label>
        {lossCopy}
        <div className="flex items-center gap-3">
          <button className={btn} disabled={busy} onClick={createVault}>{busy ? 'sealing…' : migrating ? 'Set passphrase and migrate' : 'Set passphrase'}</button>
          {err && <span className="text-xs text-red-400">{err}</span>}
        </div>
      </section>
    );
  }

  const sessionLine = !session
    ? 'checking…'
    : !session.reachable
      ? 'trading daemon unreachable'
      : session.unlocked
        ? `unlocked until ${new Date(session.expiresAt!).toLocaleString()}`
        : 'locked: your strategies are paused';

  return (
    <section className="space-y-4 rounded-2xl border border-zinc-800 bg-zinc-900/80 p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold text-zinc-100">Vault</h2>
        <span className={`text-xs ${vault ? 'text-emerald-400' : 'text-zinc-400'}`}>{vault ? 'unlocked in this tab' : 'locked'}</span>
      </div>

      {!vault && (
        <div className="space-y-2">
          <label className="block text-xs uppercase tracking-wider text-zinc-400">{useRecovery ? 'Recovery key' : 'Passphrase'}
            <input
              type={useRecovery ? 'text' : 'password'}
              autoComplete={useRecovery ? 'off' : 'current-password'}
              className={input}
              value={pass}
              onChange={(e) => setPass(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void unlockVault(); }}
            />
          </label>
          <label className="flex items-center gap-2 text-xs text-zinc-400">
            <input type="checkbox" className="accent-orange-500" checked={alsoTrading} onChange={(e) => setAlsoTrading(e.target.checked)} />
            also unlock trading for
            <select className="rounded border border-zinc-700 bg-zinc-950 px-1 py-0.5 text-zinc-200" value={ttl} onChange={(e) => setTtl(Number(e.target.value))}>
              {TTL_OPTIONS.map((o) => <option key={o.seconds} value={o.seconds}>{o.label}</option>)}
            </select>
          </label>
          <div className="flex flex-wrap items-center gap-3">
            <button className={btn} disabled={busy || !pass} onClick={unlockVault}>{busy ? 'unlocking…' : 'Unlock'}</button>
            <button className="text-xs text-zinc-500 hover:text-zinc-300" onClick={() => { setUseRecovery(!useRecovery); setPass(''); }}>
              {useRecovery ? 'use passphrase' : 'forgot passphrase? use recovery key'}
            </button>
            {err && <span className="text-xs text-red-400">{err}</span>}
          </div>
          {lossCopy}
        </div>
      )}

      {vault && !changing && (
        <div className="flex flex-wrap items-center gap-3">
          <button className={btnGhost} onClick={forget}>Lock vault in this tab</button>
          <button className={btnGhost} onClick={() => { setChanging(true); setPass(''); setPass2(''); }}>Change passphrase</button>
          {err && <span className="text-xs text-red-400">{err}</span>}
        </div>
      )}

      {vault && changing && (
        <div className="space-y-2">
          <label className="block text-xs uppercase tracking-wider text-zinc-400">New passphrase
            <input type="password" autoComplete="new-password" className={input} value={pass} onChange={(e) => setPass(e.target.value)} />
          </label>
          <label className="block text-xs uppercase tracking-wider text-zinc-400">Confirm
            <input type="password" autoComplete="new-password" className={input} value={pass2} onChange={(e) => setPass2(e.target.value)} />
          </label>
          <div className="flex items-center gap-3">
            <button className={btn} disabled={busy} onClick={changePassphrase}>{busy ? 'saving…' : 'Save new passphrase'}</button>
            <button className={btnGhost} onClick={() => setChanging(false)}>Cancel</button>
            {err && <span className="text-xs text-red-400">{err}</span>}
          </div>
        </div>
      )}

      <div className="space-y-2 border-t border-zinc-800 pt-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-sm text-zinc-200">Trading session</span>
          <span className={`text-xs ${session?.unlocked ? 'text-emerald-400' : 'text-amber-300'}`}>{sessionLine}</span>
        </div>
        <p className="text-[11px] text-zinc-500">
          The daemon can use your keys only while a session is unlocked. It holds the key in memory until the session ends, you lock it, or the daemon restarts; then your strategies pause until you unlock again.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          {vault && (
            <>
              <select className="rounded border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-200" value={ttl} onChange={(e) => setTtl(Number(e.target.value))}>
                {TTL_OPTIONS.map((o) => <option key={o.seconds} value={o.seconds}>{o.label}</option>)}
              </select>
              <button className={btn} disabled={busy} onClick={() => run(() => unlockTrading(vault, ttl))}>
                {session?.unlocked ? 'Extend' : 'Unlock trading'}
              </button>
            </>
          )}
          {session?.unlocked && <button className={btnGhost} disabled={busy} onClick={lockTrading}>Lock trading now</button>}
        </div>
      </div>
    </section>
  );
}
