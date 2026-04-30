'use client';

import { useState } from 'react';
import { BoolRow, SectionShell, readPlainBool, saveSettings, type SettingsResponse } from '../shared';

const TOGGLES = [
  { field: 'ARB_TRIANGULAR', label: 'Triangular arb scanner' },
  { field: 'DEX_TRADE_EXECUTION', label: 'DEX trade execution (live signing)' },
  { field: 'MARGIN_TRADING', label: 'Margin trading' },
  { field: 'REQUIRE_CONFIRM_UPTREND', label: 'Require uptrend confirmation' },
  { field: 'ENABLE_PROXY', label: 'Enable HTTP proxy' },
] as const;

export function TogglesSection({
  data,
  cryptoKey,
  onSaved,
}: {
  data: SettingsResponse;
  cryptoKey: CryptoKey | null;
  onSaved: (next: SettingsResponse) => void;
}) {
  const initial = Object.fromEntries(TOGGLES.map((t) => [t.field, readPlainBool(data, t.field)]));
  const [vals, setVals] = useState<Record<string, boolean>>(initial);

  const set = (f: string) => (v: boolean) => setVals((s) => ({ ...s, [f]: v }));

  const onSave = async () => {
    const plain: Record<string, boolean> = {};
    for (const t of TOGGLES) plain[t.field] = !!vals[t.field];
    const next = await saveSettings({ plain }, { cryptoKey });
    onSaved(next);
  };

  return (
    <SectionShell
      title="Toggles"
      description="Boolean feature flags. Live DEX execution should stay off until you've sized the hot wallet for what you're willing to lose."
      onSave={onSave}
    >
      {TOGGLES.map((t) => (
        <BoolRow
          key={t.field}
          field={t.field}
          label={t.label}
          value={!!vals[t.field]}
          onChange={set(t.field)}
        />
      ))}
    </SectionShell>
  );
}
