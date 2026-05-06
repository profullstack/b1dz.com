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

export function SolanaSection({
  data,
  cryptoKey,
  onSaved,
}: {
  data: SettingsResponse;
  cryptoKey: CryptoKey | null;
  onSaved: (next: SettingsResponse) => void;
}) {
  const [walletAddr, setWalletAddr] = useState(readPlainString(data, 'SOLANA_WALLET_ADDRESS'));
  const [rpcUrl, setRpcUrl] = useState(readPlainString(data, 'SOLANA_RPC_URL'));

  const [decrypted, setDecrypted] = useState<Record<string, string> | null>(null);
  const [pkDraft, setPkDraft] = useState('');
  const [pkRevealed, setPkRevealed] = useState(false);
  const [pkPendingClear, setPkPendingClear] = useState(false);
  const [ppDraft, setPpDraft] = useState('');
  const [ppRevealed, setPpRevealed] = useState(false);
  const [ppPendingClear, setPpPendingClear] = useState(false);

  const cryptoUnavailable = !cryptoKey || data.cryptoConfigured === false;

  useEffect(() => {
    if (!data.cipher || !cryptoKey) return;
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

  const onSave = async () => {
    const merged: Record<string, string> = { ...(decrypted ?? {}) };
    if (pkPendingClear) delete merged.SOLANA_PRIVATE_KEY;
    else if (pkDraft.trim() !== '') merged.SOLANA_PRIVATE_KEY = pkDraft;
    if (ppPendingClear) delete merged.PUMPPORTAL_API_KEY;
    else if (ppDraft.trim() !== '') merged.PUMPPORTAL_API_KEY = ppDraft;

    const next = await saveSettings({
      plain: {
        SOLANA_WALLET_ADDRESS: walletAddr.trim() || null,
        SOLANA_RPC_URL: rpcUrl.trim() || null,
      },
      secret: Object.keys(merged).length > 0 ? merged : null,
    }, { cryptoKey });
    onSaved(next);
    setDecrypted(merged);
    setPkDraft('');
    setPkPendingClear(false);
    setPkRevealed(false);
    setPpDraft('');
    setPpPendingClear(false);
    setPpRevealed(false);
  };

  const storedPk = decrypted?.SOLANA_PRIVATE_KEY;
  const storedPp = decrypted?.PUMPPORTAL_API_KEY;

  return (
    <SectionShell
      title="Solana"
      description="One source of truth for the Solana hot wallet. Used by every plugin that signs Solana transactions (Jupiter, Pump.fun, etc.)."
      onSave={onSave}
    >
      <PlainTextRow
        field="SOLANA_WALLET_ADDRESS"
        label="Wallet address"
        value={walletAddr}
        onChange={setWalletAddr}
        hint="Solana base58 public address"
      />
      <PlainTextRow
        field="SOLANA_RPC_URL"
        label="RPC URL"
        value={rpcUrl}
        onChange={setRpcUrl}
        hint="JSON-RPC endpoint (e.g. https://api.mainnet-beta.solana.com or a private Helius/Alchemy URL)"
      />
      <SecretRow
        field="SOLANA_PRIVATE_KEY"
        label="Hot wallet private key"
        hint="base58 secret key (88 chars). Required for live Solana trade signing."
        isSet={!!storedPk}
        length={storedPk ? storedPk.length : undefined}
        revealed={pkRevealed ? storedPk : undefined}
        draft={pkDraft}
        onDraft={setPkDraft}
        onClear={() => {
          setPkPendingClear(true);
          setPkDraft('');
          setPkRevealed(false);
        }}
        onReveal={async () => {
          if (!cryptoKey) throw new Error('encryption key not loaded');
          if (!decrypted && data.cipher) setDecrypted(await decryptSecretBlob(cryptoKey, data.cipher));
          setPkRevealed(true);
        }}
        disabled={!!cryptoUnavailable}
      />
      <SecretRow
        field="PUMPPORTAL_API_KEY"
        label="PumpPortal API key"
        hint="auth token for the realtime data stream at wss://pumpportal.fun/api/data and the /trade-local endpoint used by the pump.fun executor."
        isSet={!!storedPp}
        length={storedPp ? storedPp.length : undefined}
        revealed={ppRevealed ? storedPp : undefined}
        draft={ppDraft}
        onDraft={setPpDraft}
        onClear={() => {
          setPpPendingClear(true);
          setPpDraft('');
          setPpRevealed(false);
        }}
        onReveal={async () => {
          if (!cryptoKey) throw new Error('encryption key not loaded');
          if (!decrypted && data.cipher) setDecrypted(await decryptSecretBlob(cryptoKey, data.cipher));
          setPpRevealed(true);
        }}
        disabled={!!cryptoUnavailable}
      />
    </SectionShell>
  );
}
