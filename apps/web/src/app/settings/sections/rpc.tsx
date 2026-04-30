'use client';

import { useState } from 'react';
import { PlainTextRow, SectionShell, readPlainString, saveSettings, type SettingsResponse } from '../shared';

export function RpcSection({
  data,
  cryptoKey,
  onSaved,
}: {
  data: SettingsResponse;
  cryptoKey: CryptoKey | null;
  onSaved: (next: SettingsResponse) => void;
}) {
  const [base, setBase] = useState(readPlainString(data, 'BASE_RPC_URL'));
  const [sol, setSol] = useState(readPlainString(data, 'SOLANA_RPC_URL'));

  const onSave = async () => {
    const next = await saveSettings({
      plain: {
        BASE_RPC_URL: base.trim() || null,
        SOLANA_RPC_URL: sol.trim() || null,
      },
    }, { cryptoKey });
    onSaved(next);
  };

  return (
    <SectionShell
      title="RPC URLs"
      description="JSON-RPC endpoints used by the EVM and Solana adapters. Override with your own provider for higher throughput."
      onSave={onSave}
    >
      <PlainTextRow
        field="BASE_RPC_URL"
        label="Base RPC"
        value={base}
        onChange={setBase}
        type="url"
        hint="https://base-mainnet.g.alchemy.com/v2/… or any Base RPC"
      />
      <PlainTextRow
        field="SOLANA_RPC_URL"
        label="Solana RPC"
        value={sol}
        onChange={setSol}
        type="url"
        hint="https://api.mainnet-beta.solana.com or a paid Solana RPC"
      />
    </SectionShell>
  );
}
