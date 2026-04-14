import type { MarketSnapshot, Opportunity } from '@b1dz/core';
import type { AnalysisSignal } from './engine.js';

export interface PublishedSignal {
  side: 'buy' | 'sell';
  strength: number;
  reason: string;
}

export interface PublishedPosition {
  pair: string;
  exchange: string;
  entryPrice: number;
  volume: number;
  entryTime: number;
  strategyId?: string;
}

export interface PublishedLiquidation {
  exchange: string;
  pair: string;
  volume: number;
  discoveredAt: number;
}

interface BaseOpportunityInput {
  strategyId: string;
  exchange: string;
  pair: string;
  snap: MarketSnapshot;
  signal: PublishedSignal;
  analysis?: AnalysisSignal | null;
}

function makeOpportunityBase(
  action: 'buy' | 'sell' | 'liquidate',
  title: string,
  input: BaseOpportunityInput,
  overrides: {
    costNow: number;
    projectedReturn: number;
    projectedProfit: number;
    confidence: number;
    metadata?: Record<string, unknown>;
  },
): Opportunity {
  const now = Date.now();
  return {
    id: `crypto-trade:${input.exchange}:${input.pair}:${action}:${now}`,
    sourceId: `crypto-trade:${input.exchange}:${input.strategyId}`,
    externalId: `${input.pair}:${action}:${now}`,
    title,
    category: 'crypto-trade',
    costNow: overrides.costNow,
    projectedReturn: overrides.projectedReturn,
    projectedProfit: overrides.projectedProfit,
    confidence: overrides.confidence,
    metadata: {
      strategy: input.strategyId,
      signal: input.signal,
      snap: input.snap,
      ...(input.analysis ? { analysis: input.analysis } : {}),
      ...(overrides.metadata ?? {}),
    },
    createdAt: now,
    updatedAt: now,
  };
}

export function publishEntrySignal(input: BaseOpportunityInput & {
  projectedReturn: number;
  projectedProfit: number;
}): Opportunity {
  return makeOpportunityBase(
    'buy',
    `BUY ${input.pair} @ ${input.snap.ask.toFixed(2)} — ${input.signal.reason}`,
    input,
    {
      costNow: input.snap.ask,
      projectedReturn: input.projectedReturn,
      projectedProfit: input.projectedProfit,
      confidence: input.signal.strength,
    },
  );
}

export function publishExitSignal(input: BaseOpportunityInput & {
  position: PublishedPosition;
  projectedReturn: number;
  projectedProfit: number;
  titleReason: string;
}): Opportunity {
  return makeOpportunityBase(
    'sell',
    `SELL ${input.pair} @ ${input.snap.bid.toFixed(2)} — ${input.titleReason}`,
    input,
    {
      costNow: 0,
      projectedReturn: input.projectedReturn,
      projectedProfit: input.projectedProfit,
      confidence: Math.max(1, input.signal.strength),
      metadata: { position: input.position },
    },
  );
}

export function publishLiquidationSignal(input: BaseOpportunityInput & {
  liquidation: PublishedLiquidation;
}): Opportunity {
  return makeOpportunityBase(
    'liquidate',
    `SELL ${input.pair} @ ${input.snap.bid.toFixed(2)} — liquidate untracked holding`,
    input,
    {
      costNow: 0,
      projectedReturn: input.snap.bid * input.liquidation.volume,
      projectedProfit: 0,
      confidence: 1,
      metadata: { liquidation: input.liquidation },
    },
  );
}
