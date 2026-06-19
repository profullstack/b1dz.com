'use client';

import { useEffect, useState } from 'react';
import {
  BoolRow,
  NumberRow,
  SecretRow,
  SectionShell,
  decryptSecretBlob,
  readPlainBool,
  readPlainNumber,
  readPlainString,
  saveSettings,
  type SettingsResponse,
} from '../shared';

const SECRET_FIELDS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'] as const;
type SecretField = typeof SECRET_FIELDS[number];

/**
 * AI Analyzer (the "Coinbase Advisor" analog). b1dz calls OUT to the user's
 * OWN model for regime/setup scoring, overlaid on the deterministic engine —
 * still hard-capped by the crypto spend budget.
 *
 * BYO per-user key: Anthropic/OpenAI are API-key (not consumer-OAuth) for
 * programmatic inference, so the key is pasted and stored in the same
 * encrypted secret blob as exchange keys, read STRICTLY per-user by the daemon
 * (never an operator fallback — that's both the env-leak and the shared-key
 * single-point-of-failure we already learned about).
 */
export function AiAnalyzerSection({
  data,
  cryptoKey,
  onSaved,
}: {
  data: SettingsResponse;
  cryptoKey: CryptoKey | null;
  onSaved: (next: SettingsResponse) => void;
}) {
  const cryptoUnavailable = !cryptoKey;
  const [enabled, setEnabled] = useState(readPlainBool(data, 'AI_ANALYZER_ENABLED'));
  const [provider, setProvider] = useState<'anthropic' | 'openai'>(
    readPlainString(data, 'AI_PROVIDER') === 'openai' ? 'openai' : 'anthropic',
  );
  const [maxCalls, setMaxCalls] = useState(readPlainNumber(data, 'AI_MAX_CALLS_PER_MIN'));

  const [drafts, setDrafts] = useState<Partial<Record<SecretField, string>>>({});
  const [pendingClear, setPendingClear] = useState<Partial<Record<SecretField, true>>>({});
  const [decrypted, setDecrypted] = useState<Record<string, string> | null>(null);
  const [revealed, setRevealed] = useState<Partial<Record<SecretField, true>>>({});

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const plain = await decryptSecretBlob(cryptoKey, data.cipher);
        if (!cancelled) setDecrypted(plain);
      } catch {
        if (!cancelled) setDecrypted({});
      }
    })();
    return () => { cancelled = true; };
  }, [cryptoKey, data.cipher]);

  const setDraft = (k: SecretField) => (v: string) => setDrafts((d) => ({ ...d, [k]: v }));
  const clearField = (k: SecretField) => () => {
    setPendingClear((p) => ({ ...p, [k]: true }));
    setDrafts((d) => ({ ...d, [k]: '' }));
    setRevealed((r) => { const n = { ...r }; delete n[k]; return n; });
  };
  const revealField = (k: SecretField) => async () => {
    if (!cryptoKey) throw new Error('encryption key not loaded');
    if (!decrypted) setDecrypted(await decryptSecretBlob(cryptoKey, data.cipher));
    setRevealed((r) => ({ ...r, [k]: true }));
  };

  const num = (s: string) => (s.trim() === '' ? null : Number(s));

  const onSave = async () => {
    const merged: Record<string, string> = { ...(decrypted ?? {}) };
    for (const f of SECRET_FIELDS) {
      if (pendingClear[f]) delete merged[f];
      else if ((drafts[f] ?? '').trim() !== '') merged[f] = drafts[f]!;
    }
    const next = await saveSettings(
      {
        plain: {
          AI_ANALYZER_ENABLED: enabled,
          AI_PROVIDER: provider,
          AI_MAX_CALLS_PER_MIN: num(maxCalls),
        },
        secret: Object.keys(merged).length > 0 ? merged : null,
      },
      { cryptoKey },
    );
    onSaved(next);
    setDrafts({});
    setPendingClear({});
    setRevealed({});
    setDecrypted(merged);
  };

  const secretRow = (field: SecretField, label: string, hint?: string) => {
    const stored = decrypted?.[field];
    const isSet = !!stored;
    return (
      <SecretRow
        key={field}
        field={field}
        label={label}
        isSet={isSet}
        length={isSet ? stored?.length : undefined}
        revealed={revealed[field] ? stored : undefined}
        draft={drafts[field] ?? ''}
        onDraft={setDraft(field)}
        onClear={clearField(field)}
        onReveal={revealField(field)}
        hint={hint}
        disabled={cryptoUnavailable}
      />
    );
  };

  return (
    <div className="space-y-4">
      <p className="rounded-lg border border-violet-500/30 bg-violet-500/10 px-3 py-2 text-xs text-violet-200">
        Connect your own Claude or ChatGPT API key. b1dz uses it to score market regime/setups and overlay that on the
        deterministic strategies — it can size a buy up within your <span className="text-violet-300">spend budget</span>, never
        beyond it. Your key is encrypted in your browser and used only for your account.
      </p>

      <SectionShell
        title="AI analyzer"
        description="Off by default. With no key set, the analyzer simply stays off for your account — there is no shared/operator key."
        onSave={onSave}
      >
        <BoolRow field="AI_ANALYZER_ENABLED" label="AI analyzer enabled" value={enabled} onChange={setEnabled} />
        <div className="flex items-center justify-between gap-3 py-2">
          <label className="text-sm text-zinc-300">Provider</label>
          <select
            value={provider}
            onChange={(e) => setProvider(e.target.value as 'anthropic' | 'openai')}
            className="rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm text-zinc-100"
          >
            <option value="anthropic">Anthropic (Claude)</option>
            <option value="openai">OpenAI (ChatGPT)</option>
          </select>
        </div>
        <NumberRow field="AI_MAX_CALLS_PER_MIN" label="Max analysis calls / min" value={maxCalls} onChange={setMaxCalls} hint="Throttle to control your API spend. Default 6." />
      </SectionShell>

      <SectionShell title="API keys" onSave={onSave} description="Paste the key for the provider you selected. Both can be stored; only the selected provider is used.">
        {secretRow('ANTHROPIC_API_KEY', 'Anthropic API key', 'sk-ant-… from console.anthropic.com')}
        {secretRow('OPENAI_API_KEY', 'OpenAI API key', 'sk-… from platform.openai.com')}
      </SectionShell>
    </div>
  );
}
