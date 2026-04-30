'use client';

import { useEffect, useState } from 'react';
import {
  PlainTextRow,
  SecretRow,
  SectionShell,
  decryptSecretBlob,
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

export function CexSection({
  data,
  cryptoKey,
  cryptoUnavailable,
  onSaved,
}: {
  data: SettingsResponse;
  cryptoKey: CryptoKey | null;
  cryptoUnavailable: boolean;
  onSaved: (next: SettingsResponse) => void;
}) {
  const [coinbaseName, setCoinbaseName] = useState(readPlainString(data, 'COINBASE_API_KEY_NAME'));
  const [geminiAccount, setGeminiAccount] = useState(readPlainString(data, 'GEMINI_ACCOUNT'));
  const [drafts, setDrafts] = useState<Partial<Record<SecretField, string>>>({});
  const [pendingClear, setPendingClear] = useState<Partial<Record<SecretField, true>>>({});
  /** Decrypted plaintext of the entire secret blob (loaded eagerly so we can
   *  merge on save and serve reveal locally). Empty when no cipher exists. */
  const [decrypted, setDecrypted] = useState<Record<string, string> | null>(null);
  /** Per-field reveal flag — only show plaintext for fields the user clicked. */
  const [revealed, setRevealed] = useState<Partial<Record<SecretField, true>>>({});

  // Load + decrypt the cipher once the key + cipher are both available.
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
    if (!decrypted) {
      const plain = await decryptSecretBlob(cryptoKey, data.cipher);
      setDecrypted(plain);
    }
    setRevealed((r) => ({ ...r, [k]: true }));
  };

  const onSave = async () => {
    // Start from the latest decrypted blob (full secret object).
    const merged: Record<string, string> = { ...(decrypted ?? {}) };
    for (const f of SECRET_FIELDS) {
      if (pendingClear[f]) {
        delete merged[f];
      } else if ((drafts[f] ?? '').trim() !== '') {
        merged[f] = drafts[f]!;
      }
    }
    const next = await saveSettings(
      {
        plain: {
          COINBASE_API_KEY_NAME: coinbaseName.trim() || null,
          GEMINI_ACCOUNT: geminiAccount.trim() || null,
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

  const secretRow = (field: SecretField, label: string, multiline = false, hint?: string) => {
    const stored = decrypted?.[field];
    const isSet = !!stored;
    const isRevealed = !!revealed[field];
    return (
      <SecretRow
        key={field}
        field={field}
        label={label}
        isSet={isSet}
        length={isSet ? stored?.length : undefined}
        revealed={isRevealed ? stored : undefined}
        draft={drafts[field] ?? ''}
        onDraft={setDraft(field)}
        onClear={clearField(field)}
        onReveal={revealField(field)}
        multiline={multiline}
        hint={hint}
        disabled={cryptoUnavailable}
      />
    );
  };

  return (
    <div className="space-y-4">
      <SectionShell title="Coinbase" onSave={onSave} description="API key name is non-secret; the private key (and optional secondary) are encrypted client-side before transmit.">
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
