'use client';

import { useState } from 'react';
import {
  SecretRow,
  SectionShell,
  fetchRevealed,
  readMasked,
  saveSettings,
  type SettingsResponse,
} from '../shared';

const SECRET_FIELDS = ['ONEINCH_API_KEY', 'EVM_PRIVATE_KEY', 'SOLANA_PRIVATE_KEY'] as const;
type SecretField = typeof SECRET_FIELDS[number];

export function DexSection({ data, onSaved }: { data: SettingsResponse; onSaved: (next: SettingsResponse) => void }) {
  const [drafts, setDrafts] = useState<Partial<Record<SecretField, string>>>({});
  const [revealed, setRevealed] = useState<Partial<Record<SecretField, string>>>({});
  const [pendingClear, setPendingClear] = useState<Partial<Record<SecretField, true>>>({});

  const setDraft = (k: SecretField) => (v: string) => setDrafts((d) => ({ ...d, [k]: v }));
  const clearField = (k: SecretField) => () => {
    setPendingClear((p) => ({ ...p, [k]: true }));
    setDrafts((d) => ({ ...d, [k]: '' }));
    setRevealed((r) => ({ ...r, [k]: '' }));
  };
  const revealAll = async () => {
    const all = await fetchRevealed();
    const subset: Partial<Record<SecretField, string>> = {};
    for (const f of SECRET_FIELDS) if (typeof all[f] === 'string') subset[f] = all[f];
    setRevealed((r) => ({ ...r, ...subset }));
  };

  const onSave = async () => {
    const secret: Record<string, string | null> = {};
    for (const f of SECRET_FIELDS) {
      if (pendingClear[f]) secret[f] = null;
      else if ((drafts[f] ?? '').trim() !== '') secret[f] = drafts[f]!;
    }
    const next = await saveSettings({ secret });
    onSaved(next);
    setDrafts({});
    setPendingClear({});
    setRevealed({});
  };

  const secretRow = (field: SecretField, label: string, hint?: string) => (
    <SecretRow
      key={field}
      field={field}
      label={label}
      masked={readMasked(data, field)}
      revealed={revealed[field]}
      draft={drafts[field] ?? ''}
      onDraft={setDraft(field)}
      onClear={clearField(field)}
      onReveal={revealAll}
      hint={hint}
    />
  );

  return (
    <SectionShell
      title="DEX keys"
      description="1inch API key and hot-wallet private keys for on-chain DEX execution. Hot keys sign Uniswap-V3 / Jupiter swaps directly."
      onSave={onSave}
    >
      {secretRow('ONEINCH_API_KEY', '1inch API key', 'Required for 1inch quote/swap router')}
      {secretRow('EVM_PRIVATE_KEY', 'EVM hot wallet privkey', '0x… 64-hex (no quotes). Signs Base / Ethereum txs.')}
      {secretRow('SOLANA_PRIVATE_KEY', 'Solana hot wallet privkey', 'base58 secret key (88 chars) or JSON array')}
    </SectionShell>
  );
}
