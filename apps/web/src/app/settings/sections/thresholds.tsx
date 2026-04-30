'use client';

import { useState } from 'react';
import {
  NumberRow,
  PlainTextRow,
  SectionShell,
  readPlainNumber,
  readPlainString,
  saveSettings,
  type SettingsResponse,
} from '../shared';

interface NumField { field: string; label: string; hint?: string }

const RISK: NumField[] = [
  { field: 'DAILY_LOSS_LIMIT_PCT', label: 'Daily loss limit %', hint: 'Halts trading once realized PnL drops by this %' },
  { field: 'HARD_STOP_PCT', label: 'Hard stop %', hint: 'Per-position stop-loss as % of entry' },
  { field: 'TAKE_PROFIT_PCT', label: 'Take profit %' },
  { field: 'ENTRY_MIN_SCORE', label: 'Entry min score', hint: 'Minimum strategy score to open a position' },
  { field: 'MIN_HOLD_SECS', label: 'Min hold seconds' },
  { field: 'MIN_VOLUME_USD', label: 'Min volume USD' },
  { field: 'MIN_PER_EXCHANGE_VOL_USD', label: 'Min per-exchange vol USD' },
  { field: 'ROTATE_ADVERSE_PCT', label: 'Rotate adverse %' },
  { field: 'ROTATE_MIN_HOLD_MS', label: 'Rotate min hold (ms)' },
];
const SLIPPAGE: NumField[] = [
  { field: 'BUY_SLIPPAGE_BPS', label: 'CEX buy slippage (bps)' },
  { field: 'DEX_SLIPPAGE_BPS', label: 'DEX slippage (bps)' },
  { field: 'DEX_TRADE_BUDGET_USD', label: 'DEX trade budget USD' },
];
const AUTO_SEED: NumField[] = [
  { field: 'ARB_AUTO_SEED_MIN_USD', label: 'Min seed USD' },
  { field: 'ARB_AUTO_SEED_PER_PAIR_USD', label: 'Per-pair seed USD' },
  { field: 'ARB_AUTO_SEED_GLOBAL_USD', label: 'Global cap USD' },
  { field: 'ARB_AUTO_SEED_PROFIT_RATIO', label: 'Profit ratio' },
  { field: 'ARB_AUTO_SEED_COOLDOWN_MS', label: 'Cooldown (ms)' },
  { field: 'ARB_AUTO_SEED_EVAL_WINDOW_MS', label: 'Eval window (ms)' },
  { field: 'ARB_AUTO_SEED_PAUSE_MS', label: 'Pause (ms)' },
];
const LIQ: NumField[] = [
  { field: 'ARB_LIQ_MAX_SLICE_USD', label: 'Max slice USD' },
  { field: 'ARB_LIQ_MIN_ASSET_USD', label: 'Min asset USD' },
  { field: 'ARB_LIQ_COOLDOWN_MS', label: 'Cooldown (ms)' },
];
const TRI: NumField[] = [
  { field: 'ARB_TRIANGULAR_MIN_NET_USD', label: 'Min net USD' },
  { field: 'ARB_TRIANGULAR_SIZE_USD', label: 'Trade size USD' },
  { field: 'ARB_TRIANGULAR_INTERVAL_MS', label: 'Interval (ms)' },
  { field: 'ARB_TRIANGULAR_FEE_TIER', label: 'Fee tier' },
  { field: 'ARB_TRIANGULAR_MAX_PER_TICK', label: 'Max per tick' },
];
const MISC: NumField[] = [
  { field: 'ETH_USD_HINT', label: 'ETH/USD hint' },
  { field: 'GEMINI_NONCE_OFFSET', label: 'Gemini nonce offset' },
];

const ALL = [...RISK, ...SLIPPAGE, ...AUTO_SEED, ...LIQ, ...TRI, ...MISC];

export function ThresholdsSection({
  data,
  cryptoKey,
  onSaved,
}: {
  data: SettingsResponse;
  cryptoKey: CryptoKey | null;
  onSaved: (next: SettingsResponse) => void;
}) {
  const initial = Object.fromEntries(ALL.map((f) => [f.field, readPlainNumber(data, f.field)]));
  const [vals, setVals] = useState<Record<string, string>>(initial);
  const [triAnchor, setTriAnchor] = useState(readPlainString(data, 'ARB_TRIANGULAR_ANCHOR'));
  const [triTokens, setTriTokens] = useState(readPlainString(data, 'ARB_TRIANGULAR_TOKENS'));
  const [dexPairs, setDexPairs] = useState(readPlainString(data, 'ARB_DEX_PAIRS'));

  const setField = (k: string) => (v: string) => setVals((s) => ({ ...s, [k]: v }));

  const buildPlain = (fields: NumField[]): Record<string, number | null> => {
    const out: Record<string, number | null> = {};
    for (const f of fields) {
      const raw = (vals[f.field] ?? '').trim();
      if (raw === '') { out[f.field] = null; continue; }
      const n = Number(raw);
      if (Number.isFinite(n)) out[f.field] = n;
    }
    return out;
  };

  const onSaveSection = (fields: NumField[], extra: Record<string, string | null> = {}) => async () => {
    const next = await saveSettings({ plain: { ...buildPlain(fields), ...extra } }, { cryptoKey });
    onSaved(next);
  };

  const renderRows = (fields: NumField[]) =>
    fields.map((f) => (
      <NumberRow
        key={f.field}
        field={f.field}
        label={f.label}
        value={vals[f.field] ?? ''}
        onChange={setField(f.field)}
        hint={f.hint}
      />
    ));

  return (
    <div className="space-y-4">
      <SectionShell title="Risk" onSave={onSaveSection(RISK)}>
        <div className="grid gap-3 sm:grid-cols-2">{renderRows(RISK)}</div>
      </SectionShell>
      <SectionShell title="Slippage / Budget" onSave={onSaveSection(SLIPPAGE)}>
        <div className="grid gap-3 sm:grid-cols-2">{renderRows(SLIPPAGE)}</div>
      </SectionShell>
      <SectionShell title="Auto-seed" onSave={onSaveSection(AUTO_SEED)} description="Controls the seed-funding inventory liquidator.">
        <div className="grid gap-3 sm:grid-cols-2">{renderRows(AUTO_SEED)}</div>
      </SectionShell>
      <SectionShell title="Liquidator" onSave={onSaveSection(LIQ)}>
        <div className="grid gap-3 sm:grid-cols-2">{renderRows(LIQ)}</div>
      </SectionShell>
      <SectionShell
        title="Triangular arb"
        description="Triangular arbitrage scanner config (numeric thresholds + anchor token / token list)."
        onSave={onSaveSection(TRI, {
          ARB_TRIANGULAR_ANCHOR: triAnchor.trim() || null,
          ARB_TRIANGULAR_TOKENS: triTokens.trim() || null,
        })}
      >
        <div className="grid gap-3 sm:grid-cols-2">{renderRows(TRI)}</div>
        <PlainTextRow
          field="ARB_TRIANGULAR_ANCHOR"
          label="Anchor token"
          value={triAnchor}
          onChange={setTriAnchor}
          hint='e.g. "WETH" or "USDC"'
        />
        <PlainTextRow
          field="ARB_TRIANGULAR_TOKENS"
          label="Token list (comma-separated)"
          value={triTokens}
          onChange={setTriTokens}
          hint="Tokens to scan against the anchor"
        />
      </SectionShell>
      <SectionShell
        title="Misc"
        onSave={onSaveSection(MISC, {
          ARB_DEX_PAIRS: dexPairs.trim() || null,
        })}
      >
        <div className="grid gap-3 sm:grid-cols-2">{renderRows(MISC)}</div>
        <PlainTextRow
          field="ARB_DEX_PAIRS"
          label="DEX pair list (comma-separated)"
          value={dexPairs}
          onChange={setDexPairs}
          hint='e.g. "ETH-USD,SOL-USD"'
        />
      </SectionShell>
    </div>
  );
}
