'use client';

import { useState } from 'react';
import {
  PlainTextRow,
  NumberRow,
  BoolRow,
  SectionShell,
  readPlainString,
  readPlainNumber,
  readPlainBool,
  saveSettings,
  type SettingsResponse,
} from '../shared';

export function StrategiesSection({
  data,
  cryptoKey,
  onSaved,
}: {
  data: SettingsResponse;
  cryptoKey: CryptoKey | null;
  onSaved: (next: SettingsResponse) => void;
}) {
  // CEX Arb
  const [arbMode, setArbMode] = useState(readPlainString(data, 'ARB_MODE'));
  const [arbMaxUsd, setArbMaxUsd] = useState(readPlainNumber(data, 'ARB_MAX_TRADE_USD'));
  const [arbSizeUsd, setArbSizeUsd] = useState(readPlainNumber(data, 'ARB_SIZE_USD'));
  const [arbMinNetUsd, setArbMinNetUsd] = useState(readPlainNumber(data, 'ARB_MIN_NET_USD'));
  const [arbMinNetBps, setArbMinNetBps] = useState(readPlainNumber(data, 'ARB_MIN_NET_BPS'));
  const [arbUniswap, setArbUniswap] = useState(readPlainBool(data, 'ARB_EXECUTOR_UNISWAP_BASE'));

  // DCA
  const [dcaEnabled, setDcaEnabled] = useState(readPlainBool(data, 'DCA_ENABLED'));
  const [dcaAllocPct, setDcaAllocPct] = useState(readPlainNumber(data, 'DCA_TOTAL_ALLOCATION_PCT'));
  const [dcaMaxCoins, setDcaMaxCoins] = useState(readPlainNumber(data, 'DCA_MAX_COINS'));
  const [dcaCoins, setDcaCoins] = useState(readPlainString(data, 'DCA_COINS'));
  const [dcaExchanges, setDcaExchanges] = useState(readPlainString(data, 'DCA_EXCHANGES'));
  const [dcaIntervalMs, setDcaIntervalMs] = useState(readPlainNumber(data, 'DCA_INTERVAL_MS'));

  // V2 pipeline
  const [v2Mode, setV2Mode] = useState(readPlainString(data, 'V2_MODE'));
  const [v2SizeUsd, setV2SizeUsd] = useState(readPlainNumber(data, 'V2_SIZE_USD'));
  const [v2MaxPairs, setV2MaxPairs] = useState(readPlainNumber(data, 'V2_MAX_PAIRS'));
  const [v2MaxTradeUsd, setV2MaxTradeUsd] = useState(readPlainNumber(data, 'V2_MAX_TRADE_USD'));
  const [v2MinNetUsd, setV2MinNetUsd] = useState(readPlainNumber(data, 'V2_MIN_NET_USD'));

  // Pump.fun
  const [pfTradeSol, setPfTradeSol] = useState(readPlainNumber(data, 'PUMPFUN_TRADE_SOL'));
  const [pfMinMcap, setPfMinMcap] = useState(readPlainNumber(data, 'PUMPFUN_ENTRY_MIN_MCAP'));
  const [pfMaxMcap, setPfMaxMcap] = useState(readPlainNumber(data, 'PUMPFUN_ENTRY_MAX_MCAP'));
  const [pfMaxAgeMin, setPfMaxAgeMin] = useState(readPlainNumber(data, 'PUMPFUN_ENTRY_MAX_AGE_MIN'));
  const [pfMinAgeMin, setPfMinAgeMin] = useState(readPlainNumber(data, 'PUMPFUN_ENTRY_MIN_AGE_MIN'));
  const [pfMinReplies, setPfMinReplies] = useState(readPlainNumber(data, 'PUMPFUN_ENTRY_MIN_REPLIES'));
  const [pfMinSolReserves, setPfMinSolReserves] = useState(readPlainNumber(data, 'PUMPFUN_ENTRY_MIN_SOL_RESERVES'));
  const [pfMaxPositions, setPfMaxPositions] = useState(readPlainNumber(data, 'PUMPFUN_MAX_POSITIONS'));
  const [pfTakeProfit, setPfTakeProfit] = useState(readPlainNumber(data, 'PUMPFUN_TAKE_PROFIT_PCT'));
  const [pfStopLoss, setPfStopLoss] = useState(readPlainNumber(data, 'PUMPFUN_STOP_LOSS_PCT'));
  const [pfMaxHold, setPfMaxHold] = useState(readPlainNumber(data, 'PUMPFUN_MAX_HOLD_MIN'));
  const [pfGraduation, setPfGraduation] = useState(readPlainNumber(data, 'PUMPFUN_GRADUATION_CAP_USD'));

  const saveArb = async () => {
    const plain: Record<string, string | number | boolean | null> = {
      ARB_MODE: arbMode.trim() || null,
      ARB_MAX_TRADE_USD: arbMaxUsd !== '' ? Number(arbMaxUsd) : null,
      ARB_SIZE_USD: arbSizeUsd !== '' ? Number(arbSizeUsd) : null,
      ARB_MIN_NET_USD: arbMinNetUsd !== '' ? Number(arbMinNetUsd) : null,
      ARB_MIN_NET_BPS: arbMinNetBps !== '' ? Number(arbMinNetBps) : null,
      ARB_EXECUTOR_UNISWAP_BASE: arbUniswap,
    };
    const next = await saveSettings({ plain }, { cryptoKey });
    onSaved(next);
  };

  const saveDca = async () => {
    const plain: Record<string, string | number | boolean | null> = {
      DCA_ENABLED: dcaEnabled,
      DCA_TOTAL_ALLOCATION_PCT: dcaAllocPct !== '' ? Number(dcaAllocPct) : null,
      DCA_MAX_COINS: dcaMaxCoins !== '' ? Number(dcaMaxCoins) : null,
      DCA_COINS: dcaCoins.trim() || null,
      DCA_EXCHANGES: dcaExchanges.trim() || null,
      DCA_INTERVAL_MS: dcaIntervalMs !== '' ? Number(dcaIntervalMs) : null,
    };
    const next = await saveSettings({ plain }, { cryptoKey });
    onSaved(next);
  };

  const saveV2 = async () => {
    const plain: Record<string, string | number | boolean | null> = {
      V2_MODE: v2Mode.trim() || null,
      V2_SIZE_USD: v2SizeUsd !== '' ? Number(v2SizeUsd) : null,
      V2_MAX_PAIRS: v2MaxPairs !== '' ? Number(v2MaxPairs) : null,
      V2_MAX_TRADE_USD: v2MaxTradeUsd !== '' ? Number(v2MaxTradeUsd) : null,
      V2_MIN_NET_USD: v2MinNetUsd !== '' ? Number(v2MinNetUsd) : null,
    };
    const next = await saveSettings({ plain }, { cryptoKey });
    onSaved(next);
  };

  const savePumpfun = async () => {
    const plain: Record<string, string | number | boolean | null> = {
      PUMPFUN_TRADE_SOL: pfTradeSol !== '' ? Number(pfTradeSol) : null,
      PUMPFUN_ENTRY_MIN_MCAP: pfMinMcap !== '' ? Number(pfMinMcap) : null,
      PUMPFUN_ENTRY_MAX_MCAP: pfMaxMcap !== '' ? Number(pfMaxMcap) : null,
      PUMPFUN_ENTRY_MAX_AGE_MIN: pfMaxAgeMin !== '' ? Number(pfMaxAgeMin) : null,
      PUMPFUN_ENTRY_MIN_AGE_MIN: pfMinAgeMin !== '' ? Number(pfMinAgeMin) : null,
      PUMPFUN_ENTRY_MIN_REPLIES: pfMinReplies !== '' ? Number(pfMinReplies) : null,
      PUMPFUN_ENTRY_MIN_SOL_RESERVES: pfMinSolReserves !== '' ? Number(pfMinSolReserves) : null,
      PUMPFUN_MAX_POSITIONS: pfMaxPositions !== '' ? Number(pfMaxPositions) : null,
      PUMPFUN_TAKE_PROFIT_PCT: pfTakeProfit !== '' ? Number(pfTakeProfit) : null,
      PUMPFUN_STOP_LOSS_PCT: pfStopLoss !== '' ? Number(pfStopLoss) : null,
      PUMPFUN_MAX_HOLD_MIN: pfMaxHold !== '' ? Number(pfMaxHold) : null,
      PUMPFUN_GRADUATION_CAP_USD: pfGraduation !== '' ? Number(pfGraduation) : null,
    };
    const next = await saveSettings({ plain }, { cryptoKey });
    onSaved(next);
  };

  return (
    <div className="space-y-4">
      <SectionShell
        title="CEX Arbitrage"
        description="Cross-exchange arb (Kraken/Binance.US/Coinbase/Gemini). Leave blank to use system defaults from server env."
        onSave={saveArb}
      >
        <PlainTextRow
          field="ARB_MODE"
          label="Mode"
          value={arbMode}
          onChange={setArbMode}
          hint="observe | paper | live  (default: observe)"
        />
        <NumberRow field="ARB_MAX_TRADE_USD" label="Max trade USD" value={arbMaxUsd} onChange={setArbMaxUsd} hint="Per-leg cap, e.g. 15" />
        <NumberRow field="ARB_SIZE_USD" label="Notional size USD" value={arbSizeUsd} onChange={setArbSizeUsd} hint="Quote size per opportunity" />
        <NumberRow field="ARB_MIN_NET_USD" label="Min net profit USD" value={arbMinNetUsd} onChange={setArbMinNetUsd} hint="e.g. 0.01" />
        <NumberRow field="ARB_MIN_NET_BPS" label="Min net profit bps" value={arbMinNetBps} onChange={setArbMinNetBps} hint="e.g. 3 (= 0.03%)" />
        <BoolRow field="ARB_EXECUTOR_UNISWAP_BASE" label="Arm Uniswap V3 executor?" value={arbUniswap} onChange={setArbUniswap} />
      </SectionShell>

      <SectionShell
        title="DCA — Dollar-Cost Averaging"
        description="Passive buy schedule across CEX exchanges. Leave blank to inherit server defaults."
        onSave={saveDca}
      >
        <BoolRow field="DCA_ENABLED" label="DCA enabled?" value={dcaEnabled} onChange={setDcaEnabled} />
        <NumberRow field="DCA_TOTAL_ALLOCATION_PCT" label="Total allocation %" value={dcaAllocPct} onChange={setDcaAllocPct} hint="% of each exchange's USD to DCA per cycle. Any value 0–100 is respected (e.g. 2 = 2%). Leave blank for the 80% default." />
        <NumberRow field="DCA_MAX_COINS" label="Max coins" value={dcaMaxCoins} onChange={setDcaMaxCoins} hint="e.g. 3" />
        <PlainTextRow field="DCA_COINS" label="Coins" value={dcaCoins} onChange={setDcaCoins} hint="Comma-separated: BTC,ETH,SOL" />
        <PlainTextRow field="DCA_EXCHANGES" label="Exchanges" value={dcaExchanges} onChange={setDcaExchanges} hint="Comma-separated: kraken,coinbase,binance-us,gemini" />
        <NumberRow field="DCA_INTERVAL_MS" label="Interval ms" value={dcaIntervalMs} onChange={setDcaIntervalMs} hint="86400000 = 24h" />
      </SectionShell>

      <SectionShell
        title="Pump.fun memecoin sniper"
        description="Solana bonding-curve scanner. Tighter defaults from observation: enters tokens with some history (≥2min old, ≥3 replies, bonding curve already moved off genesis), takes profit at +50%, stops at −30%, exits at 10min if neither hits. Leave any field blank to use the default."
        onSave={savePumpfun}
      >
        <NumberRow field="PUMPFUN_TRADE_SOL" label="Trade size (SOL)" value={pfTradeSol} onChange={setPfTradeSol} hint="SOL spent per buy. Default 0.01 (~$1.80)" />
        <NumberRow field="PUMPFUN_MAX_POSITIONS" label="Max concurrent positions" value={pfMaxPositions} onChange={setPfMaxPositions} hint="Default 3" />
        <NumberRow field="PUMPFUN_ENTRY_MIN_MCAP" label="Min entry market cap (USD)" value={pfMinMcap} onChange={setPfMinMcap} hint="Default 5000. Below this is dust." />
        <NumberRow field="PUMPFUN_ENTRY_MAX_MCAP" label="Max entry market cap (USD)" value={pfMaxMcap} onChange={setPfMaxMcap} hint="Default 25000. Above this is near-graduation." />
        <NumberRow field="PUMPFUN_ENTRY_MIN_AGE_MIN" label="Min token age (minutes)" value={pfMinAgeMin} onChange={setPfMinAgeMin} hint="Default 2. Wait this long for trade history to accumulate." />
        <NumberRow field="PUMPFUN_ENTRY_MAX_AGE_MIN" label="Max token age (minutes)" value={pfMaxAgeMin} onChange={setPfMaxAgeMin} hint="Default 10. Past this we've missed the launch window." />
        <NumberRow field="PUMPFUN_ENTRY_MIN_REPLIES" label="Min replies (engagement)" value={pfMinReplies} onChange={setPfMinReplies} hint="Default 3. Filters tokens nobody is watching." />
        <NumberRow field="PUMPFUN_ENTRY_MIN_SOL_RESERVES" label="Min SOL reserves" value={pfMinSolReserves} onChange={setPfMinSolReserves} hint="Default 32 (~2 SOL of cumulative buys). Genesis bonding curve is ~30." />
        <NumberRow field="PUMPFUN_TAKE_PROFIT_PCT" label="Take profit (fraction)" value={pfTakeProfit} onChange={setPfTakeProfit} hint="0.5 = +50%. Default 0.5." />
        <NumberRow field="PUMPFUN_STOP_LOSS_PCT" label="Stop loss (fraction)" value={pfStopLoss} onChange={setPfStopLoss} hint="0.3 = −30%. Default 0.3." />
        <NumberRow field="PUMPFUN_MAX_HOLD_MIN" label="Max hold (minutes)" value={pfMaxHold} onChange={setPfMaxHold} hint="Default 10. Time-stops stalled positions." />
        <NumberRow field="PUMPFUN_GRADUATION_CAP_USD" label="Graduation exit cap (USD)" value={pfGraduation} onChange={setPfGraduation} hint="Default 55000. Exit before bonding-curve migration risk." />
      </SectionShell>

      <SectionShell
        title="V2 Arb Pipeline"
        description="Multi-venue cross-DEX pipeline. Overrides V2_* env vars. Leave blank to inherit server defaults."
        onSave={saveV2}
      >
        <PlainTextRow
          field="V2_MODE"
          label="Mode"
          value={v2Mode}
          onChange={setV2Mode}
          hint="observe | paper | live  (default: observe)"
        />
        <NumberRow field="V2_SIZE_USD" label="Notional size USD" value={v2SizeUsd} onChange={setV2SizeUsd} hint="Quote size per opportunity, e.g. 100" />
        <NumberRow field="V2_MAX_PAIRS" label="Max pairs" value={v2MaxPairs} onChange={setV2MaxPairs} hint="Scanner cap, e.g. 10" />
        <NumberRow field="V2_MAX_TRADE_USD" label="Max trade USD" value={v2MaxTradeUsd} onChange={setV2MaxTradeUsd} hint="Per-trade cap" />
        <NumberRow field="V2_MIN_NET_USD" label="Min net profit USD" value={v2MinNetUsd} onChange={setV2MinNetUsd} hint="e.g. 0.10" />
      </SectionShell>
    </div>
  );
}
