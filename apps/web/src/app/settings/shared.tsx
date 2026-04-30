'use client';

import { useState } from 'react';

export interface MaskedSecret { set: boolean; length?: number }

export interface SettingsResponse {
  plain: Record<string, string | number | boolean | null | undefined>;
  secret: Record<string, MaskedSecret> | Record<string, string | null | undefined>;
  lastUpdatedAt: string | null;
  cryptoConfigured: boolean;
}

export interface SaveBody {
  plain?: Record<string, string | number | boolean | null>;
  secret?: Record<string, string | null>;
}

export async function saveSettings(body: SaveBody): Promise<SettingsResponse> {
  const res = await fetch('/api/settings', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`save failed (${res.status}): ${txt.slice(0, 200)}`);
  }
  return (await res.json()) as SettingsResponse;
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
  masked,
  draft,
  onDraft,
  onClear,
  hint,
  multiline = false,
}: {
  field: string;
  label: string;
  masked: MaskedSecret | undefined;
  draft: string;
  onDraft: (v: string) => void;
  onClear: () => void;
  hint?: string;
  multiline?: boolean;
}) {
  const isSet = !!masked?.set;
  const placeholder = isSet
    ? `••••••••• (set, ${masked?.length ?? '?'} chars) — type to overwrite`
    : 'unset';

  return (
    <div>
      <label className="block text-xs uppercase tracking-wider text-zinc-400">
        {label} <span className="text-zinc-600 normal-case tracking-normal">{field}</span>
      </label>
      {multiline ? (
        <textarea
          value={draft}
          onChange={(e) => onDraft(e.target.value)}
          placeholder={placeholder}
          rows={4}
          className="mt-1 w-full resize-y rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 font-mono text-xs text-zinc-100 outline-none focus:border-orange-500"
        />
      ) : (
        <input
          type="password"
          value={draft}
          onChange={(e) => onDraft(e.target.value)}
          placeholder={placeholder}
          className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 font-mono text-xs text-zinc-100 outline-none focus:border-orange-500"
        />
      )}
      <div className="mt-1 flex items-center gap-3 text-[11px]">
        {hint && <span className="text-zinc-600">{hint}</span>}
        {isSet && (
          <button
            type="button"
            onClick={onClear}
            className="ml-auto text-red-400 hover:text-red-300"
          >
            clear
          </button>
        )}
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

export function readMasked(data: SettingsResponse, field: string): MaskedSecret | undefined {
  const s = data.secret as Record<string, MaskedSecret>;
  return s?.[field];
}
