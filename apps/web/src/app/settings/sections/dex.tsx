'use client';

import { useEffect, useState } from 'react';
import {
  SecretRow,
  SectionShell,
  decryptSecretBlob,
  saveSettings,
  type SettingsResponse,
} from '../shared';

const SECRET_FIELDS = ['ONEINCH_API_KEY', 'EVM_PRIVATE_KEY', 'SOLANA_PRIVATE_KEY'] as const;
type SecretField = typeof SECRET_FIELDS[number];

export function DexSection({
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
    if (!decrypted) {
      const plain = await decryptSecretBlob(cryptoKey, data.cipher);
      setDecrypted(plain);
    }
    setRevealed((r) => ({ ...r, [k]: true }));
  };

  const onSave = async () => {
    const merged: Record<string, string> = { ...(decrypted ?? {}) };
    for (const f of SECRET_FIELDS) {
      if (pendingClear[f]) delete merged[f];
      else if ((drafts[f] ?? '').trim() !== '') merged[f] = drafts[f]!;
    }
    const next = await saveSettings(
      { secret: Object.keys(merged).length > 0 ? merged : null },
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
        hint={hint}
        disabled={cryptoUnavailable}
      />
    );
  };

  return (
    <SectionShell
      title="DEX keys"
      description="1inch API key and hot-wallet private keys for on-chain DEX execution. Encrypted client-side before transmit. Hot keys sign Uniswap-V3 / Jupiter swaps directly."
      onSave={onSave}
    >
      {secretRow('ONEINCH_API_KEY', '1inch API key', 'Required for 1inch quote/swap router')}
      {secretRow('EVM_PRIVATE_KEY', 'EVM hot wallet privkey', '0x… 64-hex (no quotes). Signs Base / Ethereum txs.')}
      {secretRow('SOLANA_PRIVATE_KEY', 'Solana hot wallet privkey', 'base58 secret key (88 chars) or JSON array')}
    </SectionShell>
  );
}
