'use client';

import { useState } from 'react';
import { PlainTextRow, SectionShell, readPlainString, saveSettings, type SettingsResponse } from '../shared';

export function WalletsSection({
  data,
  cryptoKey,
  onSaved,
}: {
  data: SettingsResponse;
  cryptoKey: CryptoKey | null;
  onSaved: (next: SettingsResponse) => void;
}) {
  const [evm, setEvm] = useState(readPlainString(data, 'EVM_WALLET_ADDRESS'));
  const [sol, setSol] = useState(readPlainString(data, 'SOLANA_WALLET_ADDRESS'));

  const onSave = async () => {
    const next = await saveSettings({
      plain: {
        EVM_WALLET_ADDRESS: evm.trim() || null,
        SOLANA_WALLET_ADDRESS: sol.trim() || null,
      },
    }, { cryptoKey });
    onSaved(next);
  };

  return (
    <SectionShell
      title="Wallets"
      description="Public wallet addresses. The daemon uses these for read-only reporting; signing is gated by the privkeys under DEX keys."
      onSave={onSave}
    >
      <PlainTextRow
        field="EVM_WALLET_ADDRESS"
        label="EVM wallet"
        value={evm}
        onChange={setEvm}
        hint="Base / Ethereum / Arbitrum address (0x…)"
      />
      <PlainTextRow
        field="SOLANA_WALLET_ADDRESS"
        label="Solana wallet"
        value={sol}
        onChange={setSol}
        hint="Solana base58 address"
      />
    </SectionShell>
  );
}
