'use client';

import { useState } from 'react';
import {
  BoolRow,
  NumberRow,
  PlainTextRow,
  SectionShell,
  readPlainBool,
  readPlainNumber,
  readPlainString,
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
  const [extendedHours, setExtendedHours] = useState(readPlainBool(data, 'EQUITY_EXTENDED_HOURS'));
  const [pdtGuard, setPdtGuard] = useState(data.plain['EQUITY_PDT_GUARD'] === undefined ? true : readPlainBool(data, 'EQUITY_PDT_GUARD'));
  const [watch, setWatch] = useState(() => readPlainString(data, 'EQUITY_WATCHLIST') || 'SPY,AAPL,MSFT');
  const [perTrade, setPerTrade] = useState(readPlainNumber(data, 'EQUITY_PER_TRADE_USD'));
  const [maxPosition, setMaxPosition] = useState(readPlainNumber(data, 'EQUITY_MAX_POSITION_USD'));
  const [minSignal, setMinSignal] = useState(readPlainNumber(data, 'EQUITY_MIN_SIGNAL'));
  const [acctEquity, setAcctEquity] = useState(readPlainNumber(data, 'EQUITY_ACCOUNT_EQUITY_USD'));

  const num = (s: string) => (s.trim() === '' ? null : Number(s));

  const onSave = async () => {
    const next = await saveSettings(
      {
        plain: {
          EQUITIES_ENABLED: enabled,
          EQUITY_TRADE_EXECUTION: execution,
          ALLOW_OVERNIGHT: allowOvernight,
          MAX_OVERNIGHT_USD: num(maxOvernight),
          EQUITY_EXTENDED_HOURS: extendedHours,
          EQUITY_PDT_GUARD: pdtGuard,
          EQUITY_WATCHLIST: watch.trim() || null,
          EQUITY_PER_TRADE_USD: num(perTrade),
          EQUITY_MAX_POSITION_USD: num(maxPosition),
          EQUITY_MIN_SIGNAL: num(minSignal),
          EQUITY_ACCOUNT_EQUITY_USD: num(acctEquity),
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
        title="Sizing & strategy"
        description="The daemon runs the deterministic strategies on these symbols and the engine sizes orders within these caps. Paper brokers trade immediately; live brokers wait for the execution switch above."
        onSave={onSave}
      >
        <PlainTextRow field="EQUITY_WATCHLIST" label="Watchlist" value={watch} onChange={setWatch} hint="Comma-separated symbols, e.g. SPY,AAPL,MSFT" />
        <NumberRow field="EQUITY_PER_TRADE_USD" label="Per-trade notional (USD)" value={perTrade} onChange={setPerTrade} hint="Default 500" />
        <NumberRow field="EQUITY_MAX_POSITION_USD" label="Max position per symbol (USD)" value={maxPosition} onChange={setMaxPosition} hint="Default 2000" />
        <NumberRow field="EQUITY_MIN_SIGNAL" label="Min signal strength (0–1)" value={minSignal} onChange={setMinSignal} hint="Ignore weaker signals, e.g. 0.1" />
        <BoolRow field="EQUITY_EXTENDED_HOURS" label="Allow pre/post-market entries" value={extendedHours} onChange={setExtendedHours} />
      </SectionShell>

      <SectionShell
        title="Overnight & PDT risk"
        description="Overnight holds carry gap risk; PDT blocks the 4th day trade in 5 days for margin accounts under $25k."
        onSave={onSave}
      >
        <BoolRow field="ALLOW_OVERNIGHT" label="Allow overnight holds" value={allowOvernight} onChange={setAllowOvernight} />
        <NumberRow field="MAX_OVERNIGHT_USD" label="Max overnight exposure (USD)" value={maxOvernight} onChange={setMaxOvernight} hint="Total USD allowed to carry overnight, e.g. 5000" />
        <BoolRow field="EQUITY_PDT_GUARD" label="PDT guard (block 4th day trade < $25k)" value={pdtGuard} onChange={setPdtGuard} />
        <NumberRow field="EQUITY_ACCOUNT_EQUITY_USD" label="Account equity for PDT check (USD)" value={acctEquity} onChange={setAcctEquity} hint="Optional — set so the PDT guard knows if you're under $25k" />
      </SectionShell>
    </div>
  );
}
