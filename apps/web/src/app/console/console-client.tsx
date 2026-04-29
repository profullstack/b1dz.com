'use client';

import { useCallback, useState } from 'react';
import { useSourceState } from '@/lib/use-source-state';
import { StatusBar } from './status-bar';
import { PositionsTable } from './positions-table';
import { HoldingsPanel } from './holdings-panel';
import { SpreadsTable } from './spreads-table';
import { FooterTabs } from './footer-tabs';
import { ChartsPanel } from './charts-panel';

export function ConsoleClient() {
  const bundle = useSourceState();
  const [bump, setBump] = useState(0);
  const onMutate = useCallback(() => setBump((b) => b + 1), []);

  return (
    <div key={bump}>
      <StatusBar
        arb={bundle.arb}
        trade={bundle.trade}
        settings={bundle.settings}
        loading={bundle.loading}
        onMutate={onMutate}
      />
      <div className="space-y-4 p-4">
        <ChartsPanel arb={bundle.arb} />
        <PositionsTable trade={bundle.trade} />
        <div className="grid gap-4 lg:grid-cols-2">
          <SpreadsTable arb={bundle.arb} />
          <HoldingsPanel arb={bundle.arb} />
        </div>
        <FooterTabs arb={bundle.arb} trade={bundle.trade} pipeline={bundle.pipeline} />
        {bundle.error && (
          <p className="text-xs text-red-400">error: {bundle.error}</p>
        )}
      </div>
    </div>
  );
}
