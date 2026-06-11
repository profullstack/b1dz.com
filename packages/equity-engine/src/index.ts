/**
 * @b1dz/equity-engine — deterministic equity order decision + risk gating.
 *
 * The engine (NOT strategy authors) owns equity market structure: session
 * gating, PDT, buying-power sizing, halt/LULD, overnight, and notional-vs-share
 * sizing (PRD equities-v1 §8). A strategy only emits a Signal; this turns a
 * Signal + live account/market state into either a concrete BrokerOrderArgs or
 * a skip with a reason. It is pure and synchronous — all I/O lives in the
 * daemon worker, so every rule here is unit-testable.
 */
import type { Signal, MarketSession, BrokerOrderArgs } from '@b1dz/core';
import { countRecentDayTrades, isPdtRestricted, wouldExceedPdt } from './pdt.js';

export { countRecentDayTrades, isPdtRestricted, wouldExceedPdt } from './pdt.js';

export interface EquityRiskConfig {
  /** Notional USD per entry. */
  perTradeUsd: number;
  /** Hard cap on a single symbol's position value. */
  maxPositionUsd: number;
  /** Allow holding through the close. Default false (gap risk). */
  allowOvernight: boolean;
  /** Cap on total overnight-eligible exposure when allowOvernight is true. */
  maxOvernightUsd: number;
  /** Permit entries in pre/post sessions. */
  extendedHours: boolean;
  /** Ignore signals weaker than this (0..1). */
  minSignalStrength: number;
  /** Enforce the PDT guard for sub-$25k margin accounts. */
  pdtGuardEnabled: boolean;
  /** When overnight is disallowed, block new entries within this many minutes
   *  of the session close so positions can be flattened intraday. */
  closeBufferMin: number;
}

export const DEFAULT_EQUITY_RISK: EquityRiskConfig = {
  perTradeUsd: 500,
  maxPositionUsd: 2_000,
  allowOvernight: false,
  maxOvernightUsd: 0,
  extendedHours: false,
  minSignalStrength: 0.1,
  pdtGuardEnabled: true,
  closeBufferMin: 15,
};

export interface EquityAccount {
  buyingPowerUsd: number;
  /** Total account equity — drives the PDT $25k test. Undefined → not restricted. */
  equityUsd?: number;
  /** Day trades in the trailing 5 days (caller may precompute, else pass timestamps). */
  recentDayTrades?: number;
  /** Alternative to recentDayTrades: raw closing-day-trade timestamps. */
  dayTradeTimestamps?: number[];
}

export interface EquityPositionState {
  /** Shares currently held (0 = flat; negative shorts are not supported in v1). */
  qty: number;
  avgEntry?: number;
  /** True if this position was opened during the current trading day (PDT). */
  openedToday?: boolean;
}

export interface DecisionInput {
  signal: Signal;
  symbol: string;
  session: MarketSession;
  haltState?: 'none' | 'halted' | 'luld';
  lastPrice: number;
  account: EquityAccount;
  position: EquityPositionState;
  config: EquityRiskConfig;
  /** Broker supports fractional/notional orders (→ notional-first sizing). */
  supportsFractional: boolean;
  /** Current total overnight-eligible exposure (USD) across the account. */
  openOvernightExposureUsd?: number;
  /** For the close-buffer check; defaults to now. */
  now?: Date;
}

export type Decision =
  | { action: 'place'; order: BrokerOrderArgs; reason: string }
  | { action: 'skip'; reason: string };

function isRegular(session: MarketSession): boolean {
  return session.status === 'open';
}

function minutesToClose(session: MarketSession, now: Date): number | null {
  if (!session.nextClose) return null;
  const close = Date.parse(session.nextClose);
  if (!Number.isFinite(close)) return null;
  return (close - now.getTime()) / 60_000;
}

function recentDayTrades(account: EquityAccount, now: Date): number {
  if (account.recentDayTrades !== undefined) return account.recentDayTrades;
  if (account.dayTradeTimestamps) return countRecentDayTrades(account.dayTradeTimestamps, now.getTime());
  return 0;
}

/** Decide the order (or skip) for one signal against live account/market state. */
export function decideEquityOrder(input: DecisionInput): Decision {
  const { signal, symbol, session, haltState, lastPrice, account, position, config, supportsFractional } = input;
  const now = input.now ?? new Date();
  const skip = (reason: string): Decision => ({ action: 'skip', reason });

  // 1. Tradeability gates.
  if (haltState && haltState !== 'none') return skip(`halted (${haltState})`);
  const tradable = session.status === 'open' || (config.extendedHours && (session.status === 'pre' || session.status === 'post'));
  if (!tradable) return skip(`market ${session.status}`);
  if (!Number.isFinite(lastPrice) || lastPrice <= 0) return skip('no usable price');

  // 2. Signal strength.
  if (signal.strength < config.minSignalStrength) return skip(`signal too weak (${signal.strength.toFixed(2)})`);

  const extendedHours = !isRegular(session);
  const pdtBlocked = config.pdtGuardEnabled && wouldExceedPdt(recentDayTrades(account, now), account.equityUsd);

  // 3. Exit (sell) — close a long only; no shorting in v1.
  if (signal.side === 'sell') {
    if (position.qty <= 0) return skip('no position to exit');
    // Closing a position opened today is a day trade → PDT guard applies.
    if (position.openedToday && pdtBlocked) return skip('PDT: would be 4th day trade in 5 days');
    return {
      action: 'place',
      reason: `exit: ${signal.reason}`,
      order: { symbol, side: 'sell', qty: position.qty, type: 'market', tif: 'day', extendedHours },
    };
  }

  // 4. Entry (buy).
  const currentPosUsd = Math.max(0, position.qty) * lastPrice;
  if (currentPosUsd >= config.maxPositionUsd) return skip('position already at cap');

  if (!config.allowOvernight) {
    const mins = minutesToClose(session, now);
    if (mins !== null && mins <= config.closeBufferMin) return skip('no-overnight: too close to session close');
  }

  let sizeUsd = Math.min(config.perTradeUsd, config.maxPositionUsd - currentPosUsd, account.buyingPowerUsd);
  if (config.allowOvernight && config.maxOvernightUsd > 0) {
    sizeUsd = Math.min(sizeUsd, Math.max(0, config.maxOvernightUsd - (input.openOvernightExposureUsd ?? 0)));
  }
  if (sizeUsd <= 0) return skip('insufficient buying power or position cap reached');

  if (supportsFractional) {
    return {
      action: 'place',
      reason: `entry: ${signal.reason}`,
      order: { symbol, side: 'buy', notionalUsd: Math.round(sizeUsd * 100) / 100, type: 'market', tif: 'day', extendedHours },
    };
  }
  const qty = Math.floor(sizeUsd / lastPrice);
  if (qty < 1) return skip('computed size below 1 share');
  return {
    action: 'place',
    reason: `entry: ${signal.reason}`,
    order: { symbol, side: 'buy', qty, type: 'market', tif: 'day', extendedHours },
  };
}
