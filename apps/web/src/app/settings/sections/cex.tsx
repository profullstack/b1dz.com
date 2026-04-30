'use client';

import { useState } from 'react';
import {
  PlainTextRow,
  SecretRow,
  SectionShell,
  readMasked,
  readPlainString,
  saveSettings,
  type SettingsResponse,
} from '../shared';

const SECRET_FIELDS = [
  'COINBASE_API_PRIVATE_KEY',
  'COINBASE_API_PRIVATE_KEY_B',
  'COINBASE_EC_KEY_B',
  'KRAKEN_API_KEY',
  'KRAKEN_API_SECRET',
  'BINANCE_US_API_KEY',
  'BINANCE_US_API_SECRET',
  'GEMINI_API_KEY',
  'GEMINI_API_SECRET',
] as const;
type SecretField = typeof SECRET_FIELDS[number];

export function CexSection({ data, onSaved }: { data: SettingsResponse; onSaved: (next: SettingsResponse) => void }) {
  const [coinbaseName, setCoinbaseName] = useState(readPlainString(data, 'COINBASE_API_KEY_NAME'));
  const [geminiAccount, setGeminiAccount] = useState(readPlainString(data, 'GEMINI_ACCOUNT'));
  const [drafts, setDrafts] = useState<Partial<Record<SecretField, string>>>({});
  const [pendingClear, setPendingClear] = useState<Partial<Record<SecretField, true>>>({});

  const setDraft = (k: SecretField) => (v: string) => setDrafts((d) => ({ ...d, [k]: v }));
  const clearField = (k: SecretField) => () => {
    setPendingClear((p) => ({ ...p, [k]: true }));
    setDrafts((d) => ({ ...d, [k]: '' }));
  };

  const onSave = async () => {
    const secret: Record<string, string | null> = {};
    for (const f of SECRET_FIELDS) {
      if (pendingClear[f]) secret[f] = null;
      else if ((drafts[f] ?? '').trim() !== '') secret[f] = drafts[f]!;
    }
    const next = await saveSettings({
      plain: {
        COINBASE_API_KEY_NAME: coinbaseName.trim() || null,
        GEMINI_ACCOUNT: geminiAccount.trim() || null,
      },
      secret,
    });
    onSaved(next);
    setDrafts({});
    setPendingClear({});
  };

  const secretRow = (field: SecretField, label: string, multiline = false, hint?: string) => (
    <SecretRow
      key={field}
      field={field}
      label={label}
      masked={readMasked(data, field)}
      draft={drafts[field] ?? ''}
      onDraft={setDraft(field)}
      onClear={clearField(field)}
      multiline={multiline}
      hint={hint}
    />
  );

  return (
    <div className="space-y-4">
      <SectionShell title="Coinbase" onSave={onSave} description="API key name is non-secret; the private key (and optional secondary) are encrypted.">
        <PlainTextRow
          field="COINBASE_API_KEY_NAME"
          label="API key name"
          value={coinbaseName}
          onChange={setCoinbaseName}
          hint='e.g. "organizations/.../apiKeys/..."'
        />
        {secretRow('COINBASE_API_PRIVATE_KEY', 'Primary private key (PEM)', true, 'Pasted -----BEGIN EC PRIVATE KEY----- block')}
        {secretRow('COINBASE_API_PRIVATE_KEY_B', 'Secondary private key (PEM)', true, 'Optional second account')}
        {secretRow('COINBASE_EC_KEY_B', 'Secondary EC key', true, 'Legacy fallback for second account')}
      </SectionShell>

      <SectionShell title="Kraken" onSave={onSave}>
        {secretRow('KRAKEN_API_KEY', 'API key')}
        {secretRow('KRAKEN_API_SECRET', 'API secret')}
      </SectionShell>

      <SectionShell title="Binance.US" onSave={onSave}>
        {secretRow('BINANCE_US_API_KEY', 'API key')}
        {secretRow('BINANCE_US_API_SECRET', 'API secret')}
      </SectionShell>

      <SectionShell title="Gemini" onSave={onSave} description="Account name (primary/master/sub) is non-secret.">
        <PlainTextRow
          field="GEMINI_ACCOUNT"
          label="Account name"
          value={geminiAccount}
          onChange={setGeminiAccount}
          hint='Subaccount label (defaults to "primary")'
        />
        {secretRow('GEMINI_API_KEY', 'API key')}
        {secretRow('GEMINI_API_SECRET', 'API secret')}
      </SectionShell>
    </div>
  );
}
