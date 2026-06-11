# PRD: b1dz Equities v1 — Stock Brokers as Plugins

**Status:** Draft
**Owner:** Anthony Ettinger
**Date:** 2026-06-11
**Depends on:** `docs/prd-plugins-v0.md` (plugin contracts), `packages/core/src/plugins.ts`
**Repo:** https://github.com/profullstack/b1dz.com

---

## 1. Why this exists

b1dz today is a crypto terminal: four CEXes, a DEX roadmap, a deterministic
analysis engine, risk controls, and a plugin contract. Every part of that
stack except the venue connectors is asset-class agnostic. EMA/RSI/MACD/ATR/
VWAP, regime classification, trailing stops, daily loss limits, backtesting —
none of it cares whether the symbol is `BTC-USD` or `AAPL`.

Stock brokers now expose real user/account trading APIs (Alpaca, Interactive
Brokers, Tradier, Schwab, TradeStation, Webull OpenAPI). That means b1dz can
offer the same loop — data in, deterministic scoring, risk-gated execution —
against equities, ETFs, and (via IBKR) international markets, without a new
engine. The work is connectors, market-structure awareness, and a small
contract extension.

This also multiplies the value of the plugin store: every strategy plugin
authored against the `Signal` contract instantly addresses a second asset
class.

**Packaging decision (decided):** equities support ships as plugins, but they
are **first-party and free**. Users already pay for b1dz.com; broker
connectors and equity strategies are included in the existing subscription.
There is no per-plugin pricing, no paid tier gating, no upsell. The store
lists them with an "Included with b1dz" badge. (Third-party paid strategy
plugins remain a separate, future marketplace conversation — unchanged from
plugins v0.)

## 2. Goals

1. Trade US equities/ETFs through user-linked broker accounts with the same
   daemon loop, TUI, and web dashboard used for crypto.
2. Run the existing deterministic strategies (trend continuation, mean
   reversion, breakout/breakdown) on equities with session awareness.
3. Ship equity-native arbitrage paths that are actually real (see §7 —
   cross-broker spread arb does not exist in equities; cross-listing,
   tokenized-equity, and ETF/NAV paths do).
4. International market access where broker APIs allow it (IBKR first), with
   an FX-aware PnL model.
5. Everything lands as plugins against `packages/core/src/plugins.ts`, so the
   crypto and equity worlds compose through one registry.

## 3. Non-goals

- Becoming a broker-dealer, custodian, or RIA. b1dz never holds equities or
  cash; users link their own brokerage accounts.
- Options, futures, forex as tradable products (data-only where it falls out
  of a broker API; execution is v2+).
- US cross-broker price arbitrage. Reg NMS / NBBO makes same-symbol,
  same-market spreads across brokers a non-product. We will not pretend
  otherwise in marketing copy.
- Redistributing licensed real-time SIP data to users who haven't accepted
  the relevant exchange agreements (see §9).
- Paid plugins of any kind in this phase.
- HFT / latency-competitive execution. b1dz plays the minutes-to-days game.

## 4. Execution model (decided)

Same trust shape as plugins v0, extended one notch:

- **Strategies stay signals-only.** `evaluate()` emits `Signal` objects;
  the engine owns risk, approvals, and order submission. A strategy plugin
  cannot tell whether it is driving Kraken or Alpaca — and that's the point.
- **Broker connectors are first-party and server-side.** Same rule as DEX
  connectors in v0: third parties cannot ship connectors until there is a
  sandbox story. Broker credentials/OAuth tokens are held by b1dz's engine
  layer only, encrypted at rest, never exposed to plugin code.
- **Auth is per-user, not per-platform.** Alpaca/Tradier/Schwab use OAuth;
  IBKR uses its gateway/session model; some venues are API-key only. The
  connector contract abstracts this behind a `linkAccount()` flow owned by
  the web app.

## 5. Contract extension

New plugin kind in `packages/core/src/plugins.ts`:

```ts
export type PluginKind = 'connector' | 'strategy' | 'broker';

export interface MarketSession {
  status: 'open' | 'closed' | 'pre' | 'post';
  /** Exchange-local next open/close, ISO 8601 with offset */
  nextOpen?: string;
  nextClose?: string;
  timezone: string; // e.g. 'America/New_York', 'Europe/London'
}

export interface BrokerOrderResult {
  ok: boolean;
  message: string;
  orderId?: string;
  status?: 'accepted' | 'filled' | 'partial' | 'rejected' | 'canceled';
  fillPrice?: number;
  filledQty?: number;
}

export interface BrokerPosition {
  symbol: string;
  qty: number;            // fractional allowed
  avgEntry: number;
  marketValue: number;
  currency: string;       // 'USD', 'CAD', 'GBP', ...
  exchange?: string;      // 'NASDAQ', 'LSE', 'TSE', ...
}

export interface BrokerConnectorPlugin {
  manifest: PluginManifest & { kind: 'broker' };
  broker: string;                    // 'alpaca' | 'ibkr' | 'tradier' | ...
  markets: string[];                 // 'us', 'ca', 'uk', 'jp', ...
  session(symbol: string): Promise<MarketSession>;
  buyingPowerUsd(): Promise<number>;
  positions(): Promise<BrokerPosition[]>;
  quote(symbol: string): Promise<{ bid: number; ask: number; last: number; ts: number }>;
  placeOrder(args: {
    symbol: string;
    side: 'buy' | 'sell';
    qty?: number;                    // shares (fractional ok where supported)
    notionalUsd?: number;            // engine prefers notional when broker supports it
    type: 'market' | 'limit';
    limitPrice?: number;
    tif: 'day' | 'gtc' | 'ioc';
    extendedHours?: boolean;
  }): Promise<BrokerOrderResult>;
  cancelOrder(orderId: string): Promise<BrokerOrderResult>;
}
```

Manifest capability tags extend the existing free-form convention:
`asset:equity`, `broker:alpaca`, `market:us`, `market:intl`, `data:iex`,
`data:sip`, `feature:fractional`, `feature:extended-hours`, `feature:paper`.

`MarketSnapshot` gains optional fields rather than forking:
`assetClass?: 'crypto' | 'equity'`, `session?: MarketSession`,
`currency?: string`, `haltState?: 'none' | 'halted' | 'luld'`. Crypto paths
ignore them; equity strategies and the risk engine read them. Existing
consumers continue to compile (same rule as plugins v0 acceptance criteria).

## 6. Venue rollout

New packages, one broker per package, mirroring `source-dealdash` /
`source-crypto-trade` conventions:

**Phase 1 — `source-alpaca` (US, the reference implementation).**
API-first broker, commission-free US stocks/ETFs, REST + WebSocket, OAuth,
fractional/notional orders, and a paper-trading environment that mirrors
production. All Phase 1 development and the entire equity engine test suite
run against Alpaca paper. Free IEX data tier for development; SIP upgrade is
a config flag. This phase proves the `BrokerConnectorPlugin` contract the
way Uniswap V3 (Base) proved `ConnectorPlugin`.

**Phase 2 — `source-tradier` and `source-ibkr` (depth + breadth).**
Tradier is the cleanest second US implementation (REST + streaming, OAuth,
built as a brokerage API company) and validates that the contract isn't
secretly Alpaca-shaped. IBKR (Client Portal Web API) is the heavy one:
session-keepalive auth, pacing limits, but it unlocks the international
goal — LSE, TSE, XETRA, HKEX, TSX and dozens more through one connector with
`markets: ['us','ca','uk','de','jp','hk', ...]`.

**Phase 3 — `source-schwab`, `source-tradestation`, `source-webull`.**
Demand-driven. Schwab brings the largest retail user base (OAuth, ~120
req/min); TradeStation and Webull OpenAPI round out coverage. Each is a
contained package against a by-then-stable contract; community demand from
the store decides ordering.

Every connector ships with `feature:paper` where the broker offers it, and
the daemon refuses live equity execution until a connector has passed the
shared conformance test suite (order lifecycle, partial fills, rejections,
session edge cases) in paper mode.

## 7. Arbitrage for equities (the honest section)

The crypto arb model — same asset, different venue, different price — mostly
does not exist inside a single national equity market. US brokers all route
into one consolidated market; AAPL costs the same everywhere by regulation.
So the equity arb product is rebuilt from paths that are real:

**7.1 Cross-listing / interlisted spread (international).** The same company
trading on two exchanges in two currencies: TSX/NYSE interlisted names,
LSE/JSE dual-listings, ADRs vs home-market ordinaries. The scanner computes
`spread = price_A − price_B × fx`, nets out fees and FX cost, and surfaces it
exactly like today's theoretical spread arb. Executable mode follows the
inventory-arb rule: only fires when the user already holds the asset on the
rich side and settled cash on the cheap side (IBKR multi-market accounts make
both legs possible under one roof). Overlapping-session windows only.

**7.2 Tokenized equities vs underlying (crypto ↔ stocks bridge).** Tokenized
stocks (e.g. xStocks-style assets on Solana) trade 24/7 on DEXes b1dz already
targets (Jupiter), while the underlying trades 9:30–16:00 ET. Price gaps
between the token and the equity — especially around opens, closes, and
overnight news — are a spread surface no equity-only or crypto-only terminal
sees. b1dz uniquely has both legs. v1 ships this **discovery-only**
(theoretical spread tracking, alerts); execution is gated on legal review
(§10) and liquidity-depth checks, same posture as DEX execution today.

**7.3 ETF vs basket/NAV dislocation (signals-only).** Track ETF price vs
iNAV/underlying basket for liquid ETFs. True creation/redemption arb is
AP-only; b1dz treats persistent premium/discount as a mean-reversion *signal*
feeding the strategy layer, not an arb route. Labeled accordingly in the UI.

**7.4 What we will not ship:** "buy on Robinhood, sell on Schwab" — it isn't
a thing, and shipping a fake version of it would torch credibility with
exactly the users b1dz wants.

The existing scanner's two-lane design (theoretical vs executable,
inventory-backed) carries over unchanged; 7.1 and 7.2 are new route types in
the same pipeline.

## 8. Strategy parity + risk engine additions

The three deterministic strategy families run on equities via the same
`evaluate()` contract, with the engine (not strategy authors) enforcing
equity market structure:

- **Session gating.** No entries while `session.status !== 'open'` unless the
  user opts into extended hours; positions flagged for review before close if
  the user has day-trade-only mode on. Daemon scheduler becomes
  calendar-aware (exchange holidays, half-days) per market.
- **PDT guard.** For US margin accounts under $25k, the engine counts day
  trades and hard-blocks the 4th in 5 rolling days. Surfaced in TUI/dashboard
  like the existing daily loss limit.
- **Buying power model.** T+1 settlement and cash-vs-margin buying power
  replace the simple quote-balance check. Connector reports
  `buyingPowerUsd()`; engine never sizes past it.
- **Halt / LULD awareness.** No orders into halted or limit-state symbols;
  open positions in halted names raise an alert event.
- **Gap risk.** Overnight holds re-evaluated at open; trailing stops know a
  stop is not a fill through a gap. Risk config gains `MAX_OVERNIGHT_USD` and
  `ALLOW_OVERNIGHT` (default false), siblings of `DEX_TRADE_MAX_USD`.
- **Fractional sizing.** Notional-first sizing where supported
  (`feature:fractional`), share-rounding fallback elsewhere — the equity
  analogue of the per-exchange lot/min-notional normalization already on the
  crypto TODO.
- **FX leg.** Non-USD positions marked to USD for equity, PnL, and loss-limit
  math; FX rate source is a core service, not per-connector.

Backtesting reuses the same engine with equity fee/slippage assumptions,
session calendars, and splits/dividends adjustment in the candle store.

## 9. Market data

- Phase 1: broker-provided data (Alpaca IEX free tier) for both engine and
  charts. Sufficient for minutes-to-days strategies.
- SIP/consolidated real-time and international feeds are licensed per-user
  through the broker relationship (users accept exchange agreements at the
  broker, b1dz consumes via their token). b1dz does not redistribute licensed
  data across users.
- OHLC chart pane, timeframe switching, entry/exit markers carry over;
  candle bootstrap gains an equities source with split/dividend adjustment.
- Symbol model: introduce a namespaced internal ID (`eq:AAPL@NASDAQ`,
  `eq:SHEL@LSE`, `cx:BTC-USD@kraken`) so the cross-listing and tokenized-arb
  scanners can relate instruments. Display names stay human.

## 10. Compliance posture

Not legal advice to ourselves, but the framing the product holds: b1dz is
software that routes user-directed orders to the user's own brokerage via
that broker's official API — same posture as the crypto side. Action items:
broker API terms review per venue (some prohibit certain automation
patterns), disclosure copy for automated-trading risk, and a legal pass on
tokenized-equity execution (7.2) before it leaves discovery-only mode.
Marketing never uses "guaranteed", "riskless", or arb language for §7.3.

## 11. Acceptance criteria (Phase 1)

- `packages/core` exports `BrokerConnectorPlugin`, `MarketSession`,
  `BrokerOrderResult`, `BrokerPosition`; `PluginKind` includes `'broker'`.
  All existing crypto consumers compile unchanged.
- `source-alpaca` passes the connector conformance suite against Alpaca
  paper: link account (OAuth), stream quotes, place/cancel market and limit
  orders, handle partial fills and rejections, report positions and buying
  power.
- Trend continuation, mean reversion, and breakout strategies produce
  signals on equity snapshots and complete a full paper round-trip
  (entry → trailing stop / take-profit → exit) under session gating.
- PDT guard, buying-power sizing, session gating, and `ALLOW_OVERNIGHT`
  default-off are enforced by the engine and visible in TUI + dashboard.
- Backtest runs on at least one year of daily + intraday equity data with
  fees, slippage, and session calendar applied.
- Store lists `source-alpaca` and the equity strategy plugins with an
  "Included with b1dz" badge; no payment path exists for them.
- Live equity execution remains behind `EQUITY_TRADE_EXECUTION=false` by
  default, mirroring `DEX_TRADE_EXECUTION`.

## 12. Open questions

1. Does `BrokerConnectorPlugin` subsume CEX connectors eventually (one
   venue contract with capability flags), or do `connector` and `broker`
   stay sibling kinds forever?
2. IBKR auth UX: gateway session keepalive is hostile for a consumer
   product — do we require IBKR's OAuth (institutional-leaning) or ship a
   managed gateway per user?
3. Where does the exchange calendar live — vendored static data,
   broker-API-derived, or a maintained core package?
4. For 7.2, what venue depth threshold makes a tokenized-equity spread
   "executable" rather than noise?
5. Corporate actions in the position model: who is the source of truth for
   splits/dividends mid-position — broker API or our candle store?
6. Do equity strategies get separate per-asset-class risk envelopes, or one
   global envelope across crypto + equities per user?

## 13. Milestones

1. **M1 — Contract + Alpaca paper.** Types in core, `source-alpaca`,
   conformance suite, session-aware scheduler. (Engine work dominates.)
2. **M2 — Strategies + risk on equities.** Three strategy families running
   paper end-to-end with PDT/buying-power/overnight guards; backtests.
3. **M3 — Live US trading.** Alpaca live behind the flag; Tradier connector
   to validate contract neutrality; store listings (free, included).
4. **M4 — International + arb routes.** IBKR connector, FX service,
   cross-listing scanner (7.1), tokenized-equity discovery (7.2),
   ETF premium/discount signal (7.3).
5. **M5 — Long tail.** Schwab / TradeStation / Webull by store demand.
