'use client';

import { useState } from 'react';
import {
  BoolRow,
  NumberRow,
  SectionShell,
  readPlainBool,
  readPlainNumber,
  saveSettings,
  type SettingsResponse,
} from '../shared';

/**
 * Equities — GLOBAL engine settings only.
 *
 * Per-broker credentials (API keys, that broker's paper/sandbox toggle, account
 * id) live in each broker plugin's config in the Plugins tab — same split as DEX
 * connectors (shared keys/engine settings here, per-connector params in the
 * plugin). These globals are read by the daemon's equities worker.
 */
export function EquitiesSection({
  data,
  cryptoKey,
  onSaved,
}: {
  data: SettingsResponse;
  cryptoKey: CryptoKey | null;
  onSaved: (next: SettingsResponse) => void;
}) {
  const [enabled, setEnabled] = useState(readPlainBool(data, 'EQUITIES_ENABLED'));
  const [execution, setExecution] = useState(readPlainBool(data, 'EQUITY_TRADE_EXECUTION'));
  const [allowOvernight, setAllowOvernight] = useState(readPlainBool(data, 'ALLOW_OVERNIGHT'));
  const [maxOvernight, setMaxOvernight] = useState(readPlainNumber(data, 'MAX_OVERNIGHT_USD'));

  const onSave = async () => {
    const next = await saveSettings(
      {
        plain: {
          EQUITIES_ENABLED: enabled,
          EQUITY_TRADE_EXECUTION: execution,
          ALLOW_OVERNIGHT: allowOvernight,
          MAX_OVERNIGHT_USD: maxOvernight.trim() === '' ? null : Number(maxOvernight),
        },
      },
      { cryptoKey },
    );
    // Mirror the master switch into the daemon's source_state so the equities
    // worker is (de)scheduled. Best-effort — settings already saved above.
    try {
      await fetch('/api/equities', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
    } catch { /* non-fatal: settings persisted regardless */ }
    onSaved(next);
  };

  return (
    <div className="space-y-4">
      <p className="rounded-lg border border-sky-500/30 bg-sky-500/10 px-3 py-2 text-xs text-sky-200">
        Global equity-trading settings. Connect a brokerage and set its API keys / paper mode under <span className="text-sky-300">Plugins → Equity Trading Connectors</span>. b1dz never holds your funds — orders route to your own broker.
      </p>

      <SectionShell
        title="Equities engine"
        description="Master switch + live-execution gate. Live equity execution stays OFF until you explicitly enable it; brokers default to paper mode in their own plugin settings."
        onSave={onSave}
      >
        <BoolRow field="EQUITIES_ENABLED" label="Equities trading enabled (master)" value={enabled} onChange={setEnabled} />
        <BoolRow field="EQUITY_TRADE_EXECUTION" label="Live equity execution (off = observe/paper only)" value={execution} onChange={setExecution} />
      </SectionShell>

      <SectionShell
        title="Overnight risk"
        description="Holding equity positions overnight exposes you to gap risk through the close. Off by default."
        onSave={onSave}
      >
        <BoolRow field="ALLOW_OVERNIGHT" label="Allow overnight holds" value={allowOvernight} onChange={setAllowOvernight} />
        <NumberRow field="MAX_OVERNIGHT_USD" label="Max overnight exposure (USD)" value={maxOvernight} onChange={setMaxOvernight} hint="Total USD allowed to carry overnight, e.g. 5000" />
      </SectionShell>
    </div>
  );
}
