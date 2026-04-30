'use client';

import { useState } from 'react';
import { encryptJson, decryptJson, type CipherBlob } from '@/lib/browser-crypto';

export interface SettingsResponse {
  plain: Record<string, string | number | boolean | null | undefined>;
  cipher: CipherBlob | null;
  lastUpdatedAt: string | null;
  cryptoConfigured: boolean;
}

export interface SaveBody {
  plain?: Record<string, string | number | boolean | null>;
  /**
   * The COMPLETE secret object after this section's edits, plaintext.
   * Will be encrypted client-side before PUT. If undefined, cipher is
   * not touched. If `null`, cipher is cleared.
   */
  secret?: Record<string, string> | null;
}

export interface SaveContext {
  /** AES-256-GCM key for encrypting the secret blob. May be null if not yet
   *  loaded or if SETTINGS_ENCRYPTION_KEY is not configured server-side. */
  cryptoKey: CryptoKey | null;
}

export async function saveSettings(body: SaveBody, ctx: SaveContext): Promise<SettingsResponse> {
  const wireBody: { plain?: SaveBody['plain']; cipher?: CipherBlob | null } = {};
  if (body.plain !== undefined) wireBody.plain = body.plain;

  if (body.secret === null) {
    wireBody.cipher = null;
  } else if (body.secret !== undefined) {
    if (!ctx.cryptoKey) throw new Error('encryption key unavailable; cannot save secrets');
    wireBody.cipher = await encryptJson(ctx.cryptoKey, body.secret);
  }

  const res = await fetch('/api/settings', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(wireBody),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`save failed (${res.status}): ${txt.slice(0, 200)}`);
  }
  return (await res.json()) as SettingsResponse;
}

/**
 * Decrypt the cipher blob to a plaintext secret map. Returns {} if there's
 * nothing to decrypt. Errors propagate so callers can surface them.
 */
export async function decryptSecretBlob(
  key: CryptoKey | null,
  cipher: CipherBlob | null,
): Promise<Record<string, string>> {
  if (!cipher || !key) return {};
  return decryptJson<Record<string, string>>(key, cipher);
}

interface SectionShellProps {
  title: string;
  description?: string;
  onSave: () => Promise<void>;
  children: React.ReactNode;
}

export function SectionShell({ title, description, onSave, children }: SectionShellProps) {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ kind: 'idle' | 'ok' | 'err'; msg?: string }>({ kind: 'idle' });

  const handle = async () => {
    setBusy(true);
    setStatus({ kind: 'idle' });
    try {
      await onSave();
      setStatus({ kind: 'ok', msg: 'saved' });
    } catch (e) {
      setStatus({ kind: 'err', msg: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded-2xl border border-zinc-800 bg-zinc-900/80 p-5">
      <header className="mb-4">
        <h2 className="text-lg font-semibold text-zinc-100">{title}</h2>
        {description && <p className="mt-1 text-xs text-zinc-500">{description}</p>}
      </header>
      <div className="space-y-3">{children}</div>
      <div className="mt-5 flex items-center gap-3">
        <button
          onClick={handle}
          disabled={busy}
          className="rounded-lg bg-gradient-to-r from-orange-500 to-amber-500 px-4 py-2 text-sm font-semibold text-black hover:from-orange-400 hover:to-amber-400 disabled:opacity-50"
        >
          {busy ? 'saving…' : 'Save'}
        </button>
        {status.kind === 'ok' && <span className="text-xs text-emerald-400">{status.msg}</span>}
        {status.kind === 'err' && <span className="text-xs text-red-400">{status.msg}</span>}
      </div>
    </section>
  );
}

export function PlainTextRow({
  field,
  label,
  value,
  onChange,
  hint,
  type = 'text',
}: {
  field: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  hint?: string;
  type?: 'text' | 'url';
}) {
  return (
    <div>
      <label className="block text-xs uppercase tracking-wider text-zinc-400">{label} <span className="text-zinc-600 normal-case tracking-normal">{field}</span></label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-orange-500"
      />
      {hint && <p className="mt-1 text-[11px] text-zinc-600">{hint}</p>}
    </div>
  );
}

export function NumberRow({
  field,
  label,
  value,
  onChange,
  hint,
}: {
  field: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  hint?: string;
}) {
  return (
    <div>
      <label className="block text-xs uppercase tracking-wider text-zinc-400">{label} <span className="text-zinc-600 normal-case tracking-normal">{field}</span></label>
      <input
        type="number"
        step="any"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-orange-500"
      />
      {hint && <p className="mt-1 text-[11px] text-zinc-600">{hint}</p>}
    </div>
  );
}

export function BoolRow({
  field,
  label,
  value,
  onChange,
}: {
  field: string;
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-3 rounded-lg border border-zinc-800 bg-zinc-950/50 px-3 py-2">
      <span className="text-sm text-zinc-200">{label} <span className="ml-1 text-[10px] uppercase tracking-wider text-zinc-600">{field}</span></span>
      <input
        type="checkbox"
        checked={value}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4 accent-orange-500"
      />
    </label>
  );
}

export function SecretRow({
  field,
  label,
  isSet,
  length,
  revealed,
  draft,
  onDraft,
  onClear,
  onReveal,
  hint,
  multiline = false,
  disabled = false,
}: {
  field: string;
  label: string;
  isSet: boolean;
  /** Plaintext length when revealed. Undefined when not yet revealed. */
  length: number | undefined;
  /** Local plaintext after a reveal click. Undefined while masked. */
  revealed: string | undefined;
  draft: string;
  onDraft: (v: string) => void;
  onClear: () => void;
  onReveal: () => Promise<void>;
  hint?: string;
  multiline?: boolean;
  disabled?: boolean;
}) {
  const [revealBusy, setRevealBusy] = useState(false);
  const [revealErr, setRevealErr] = useState<string | null>(null);
  const hasReveal = revealed !== undefined;
  const placeholder = isSet
    ? hasReveal && length !== undefined
      ? `set, ${length} chars — type to overwrite`
      : `••••••••• (set) — type to overwrite or click reveal`
    : 'unset';

  const handleReveal = async () => {
    setRevealBusy(true);
    setRevealErr(null);
    try {
      await onReveal();
    } catch (e) {
      setRevealErr((e as Error).message);
    } finally {
      setRevealBusy(false);
    }
  };

  return (
    <div>
      <label className="block text-xs uppercase tracking-wider text-zinc-400">
        {label} <span className="text-zinc-600 normal-case tracking-normal">{field}</span>
      </label>
      {multiline ? (
        <textarea
          value={draft}
          onChange={(e) => onDraft(e.target.value)}
          placeholder={hasReveal && draft === '' ? revealed : placeholder}
          rows={4}
          disabled={disabled}
          className="mt-1 w-full resize-y rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 font-mono text-xs text-zinc-100 outline-none focus:border-orange-500 disabled:opacity-50"
        />
      ) : (
        <input
          type={hasReveal ? 'text' : 'password'}
          value={draft}
          onChange={(e) => onDraft(e.target.value)}
          placeholder={hasReveal && draft === '' ? revealed : placeholder}
          disabled={disabled}
          className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 font-mono text-xs text-zinc-100 outline-none focus:border-orange-500 disabled:opacity-50"
        />
      )}
      <div className="mt-1 flex items-center gap-3 text-[11px]">
        {hint && <span className="text-zinc-600">{hint}</span>}
        {revealErr && <span className="text-red-400">{revealErr}</span>}
        <span className="ml-auto flex items-center gap-3">
          {isSet && !hasReveal && (
            <button
              type="button"
              onClick={handleReveal}
              disabled={revealBusy || disabled}
              className="text-zinc-500 hover:text-zinc-300 disabled:opacity-50"
              title="Decrypt locally and show plaintext"
            >
              {revealBusy ? 'revealing…' : '👁 reveal'}
            </button>
          )}
          {isSet && (
            <button
              type="button"
              onClick={onClear}
              disabled={disabled}
              className="text-red-400 hover:text-red-300 disabled:opacity-50"
            >
              clear
            </button>
          )}
        </span>
      </div>
    </div>
  );
}

export function readPlainString(data: SettingsResponse, field: string): string {
  const v = data.plain[field];
  return typeof v === 'string' ? v : '';
}

export function readPlainNumber(data: SettingsResponse, field: string): string {
  const v = data.plain[field];
  return typeof v === 'number' ? String(v) : '';
}

export function readPlainBool(data: SettingsResponse, field: string): boolean {
  const v = data.plain[field];
  return v === true;
}
