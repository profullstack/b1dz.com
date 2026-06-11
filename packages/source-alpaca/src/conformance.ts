/**
 * Shared broker-connector conformance suite (PRD equities-v1 §6).
 *
 * The daemon refuses live equity execution until a connector passes this in
 * paper mode. It is broker-agnostic on purpose — `source-tradier`,
 * `source-ibkr`, etc. import it and pass their own factory:
 *
 *   import { runBrokerConformance } from '@b1dz/source-alpaca/conformance';
 *   runBrokerConformance('tradier', () => ({ connector, testSymbol: 'AAPL' }));
 *
 * It exercises every contract method and the order lifecycle. To stay safe
 * against a live paper account it only ever submits a single buy *limit* order
 * priced far below the market (so it rests, never fills) and then cancels it —
 * no market orders, no real fills. Partial-fill and rejection *mapping* is
 * covered by per-connector unit tests, since those states can't be forced
 * deterministically against a real venue.
 */
import { describe, it, expect } from 'vitest';
import type { BrokerConnectorPlugin } from './types.js';

export interface ConformanceContext {
  connector: BrokerConnectorPlugin;
  /** A symbol the connector's market actually trades, e.g. 'AAPL'. */
  testSymbol: string;
  /**
   * Set false to skip the place/cancel lifecycle (read-only environments).
   * Defaults to true — the lifecycle is the point of the suite.
   */
  allowOrderPlacement?: boolean;
}

const VALID_STATUSES = new Set(['accepted', 'filled', 'partial', 'rejected', 'canceled']);
const VALID_SESSIONS = new Set(['open', 'closed', 'pre', 'post']);

export function runBrokerConformance(
  suiteName: string,
  makeContext: () => ConformanceContext | Promise<ConformanceContext>,
): void {
  describe(`broker conformance: ${suiteName}`, () => {
    let ctx: ConformanceContext;

    it('exposes a well-formed broker manifest', async () => {
      ctx = await makeContext();
      const { connector } = ctx;
      expect(connector.manifest.kind).toBe('broker');
      expect(connector.manifest.id).toBeTruthy();
      expect(connector.broker).toBeTruthy();
      expect(Array.isArray(connector.markets)).toBe(true);
      expect(connector.markets.length).toBeGreaterThan(0);
      expect(connector.manifest.capabilities).toContain('asset:equity');
    });

    it('reports a valid market session', async () => {
      const s = await ctx.connector.session(ctx.testSymbol);
      expect(VALID_SESSIONS.has(s.status)).toBe(true);
      expect(s.timezone).toBeTruthy();
    });

    it('reports non-negative finite buying power', async () => {
      const bp = await ctx.connector.buyingPowerUsd();
      expect(Number.isFinite(bp)).toBe(true);
      expect(bp).toBeGreaterThanOrEqual(0);
    });

    it('reports positions with contract-complete fields', async () => {
      const positions = await ctx.connector.positions();
      expect(Array.isArray(positions)).toBe(true);
      for (const p of positions) {
        expect(typeof p.symbol).toBe('string');
        expect(Number.isFinite(p.qty)).toBe(true);
        expect(Number.isFinite(p.avgEntry)).toBe(true);
        expect(Number.isFinite(p.marketValue)).toBe(true);
        expect(p.currency).toBeTruthy();
      }
    });

    it('returns a numeric quote for the test symbol', async () => {
      const q = await ctx.connector.quote(ctx.testSymbol);
      expect(Number.isFinite(q.bid)).toBe(true);
      expect(Number.isFinite(q.ask)).toBe(true);
      expect(Number.isFinite(q.last)).toBe(true);
      expect(Number.isFinite(q.ts)).toBe(true);
    });

    it('rejects a limit order missing a limit price', async () => {
      const r = await ctx.connector.placeOrder({
        symbol: ctx.testSymbol,
        side: 'buy',
        qty: 1,
        type: 'limit',
        tif: 'day',
      });
      expect(r.ok).toBe(false);
    });

    it('rejects an order with neither qty nor notional', async () => {
      const r = await ctx.connector.placeOrder({
        symbol: ctx.testSymbol,
        side: 'buy',
        type: 'market',
        tif: 'day',
      });
      expect(r.ok).toBe(false);
    });

    it('completes a place → cancel lifecycle for a resting limit order', async () => {
      if (ctx.allowOrderPlacement === false) return;

      const q = await ctx.connector.quote(ctx.testSymbol);
      const ref = q.last || q.bid || 1;
      // Price far below market so it rests on the book and never fills.
      const limitPrice = Math.max(0.01, Math.round(ref * 0.5 * 100) / 100);

      const placed = await ctx.connector.placeOrder({
        symbol: ctx.testSymbol,
        side: 'buy',
        qty: 1,
        type: 'limit',
        limitPrice,
        tif: 'day',
      });
      expect(placed.ok).toBe(true);
      expect(placed.orderId).toBeTruthy();
      expect(placed.status && VALID_STATUSES.has(placed.status)).toBe(true);

      const canceled = await ctx.connector.cancelOrder(placed.orderId!);
      expect(canceled.orderId).toBe(placed.orderId);
      // Cancel either succeeds, or races a fill/already-terminal order — both
      // are contract-valid as long as a structured result comes back.
      expect(typeof canceled.ok).toBe('boolean');
      expect(typeof canceled.message).toBe('string');
    });
  });
}
