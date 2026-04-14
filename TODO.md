# TODO

Tracks PRD v2 build-out. Organized by PRD section / phase. The v1
composite-scalper engine stays in-tree but live-disabled via the `[d]`
TUI toggle while v2 is built alongside.

## Legend
- [x] shipped
- [ ] outstanding
- [~] partial (more detail in the item)

---

## Phase 1 — Normalized Quote Infrastructure (PRD §29 Phase 1)

### Shared types + interfaces (PRD §13, §14)
- [x] `NormalizedQuote` type — `packages/venue-types/src/index.ts`
- [x] `Opportunity` type — same
- [x] `VenueAdapter` interface (health / supports / quote) — same
- [x] `buildOpportunity` helper + 4 unit tests — same
- [ ] Add `venueMarketType: 'spot' | 'perp'` tag per PRD §14.1.1 so we never
      accidentally compare spot to perp without basis logic
- [ ] Move type package to `packages/types` to match PRD §31 repo layout
      (current name `venue-types` is fine but PRD calls it `/types`)

### Token registry (PRD §18)
- [~] EVM MVP tokens hardcoded (ETH/WETH, USDC, USDT, DAI, WBTC/cbBTC) on
      ethereum / base / avalanche / arbitrum / optimism / polygon —
      `packages/adapters-evm/src/tokens.ts`
- [~] Solana MVP mints hardcoded (SOL/WSOL, USDC, USDT) —
      `packages/adapters-solana/src/mints.ts`
- [ ] Promote to standalone `packages/token-registry` package with full
      PRD §18 fields: stablecoin flag, wrapped/native mapping, safety
      status, allowlisted flag, disabled flag, common venues,
      pumpFunFlag, pumpLifecycleState, denylistReason
- [ ] ETH<->WETH auto-unwrap when the quote asset is requested as "ETH"
- [ ] USDC-variant handling per chain (USDC vs USDbC on Base, USDC.e on
      Avalanche, etc.)
- [ ] Fee-on-transfer token detection + auto-deny

### Chain config registry (PRD §7, §12.1)
- [ ] `packages/config` module with per-chain RPC URL(s), fallback RPCs,
      block time, native asset, EIP-1559 support flag
- [ ] MVP chain allowlist: Base, Avalanche, Ethereum (reference-only),
      Solana mainnet-beta
- [ ] Optional later: Arbitrum, Optimism, Polygon, BNB Chain

### Profitability engine (PRD §19)
- [x] `rankCrossVenueOpportunities()` — `packages/profitability/src/index.ts`
      + 8 unit tests
- [x] Accounts for: fees, gas, slippage, riskBuffer, staleness, min-net,
      min-bps
- [ ] `approvalCostUsd` factored into net when adapter reports
      `allowanceRequired` (we track the flag but don't subtract yet)
- [ ] `transferCostUsd` — when adapter requires asset movement between
      venues before trade settles
- [ ] Pump.fun liquidity-decay and dump-risk buffers per §19.1
- [ ] Per-asset / per-chain minimum edge overrides per §19.2
- [ ] Regime-aware stricter thresholds during gas spikes / high volatility

### Observe / daemon split (PRD §11A)
- [~] `b1dz observe` CLI — one-shot quote + rank pass (good enough for
      manual use). See `apps/cli/src/observe.ts`
- [ ] Streaming observe loop — continuous quote cycle at configurable
      cadence per venue, emits events
- [ ] Event channel — Redis streams / NATS / Postgres queue (pick one)
- [ ] Trade daemon: subscribes to events, applies final risk+balance
      checks, decides execute / paper / reject, tracks receipts
- [ ] Top-N live opportunity feed + health/latency metrics per venue

### Wallet provider abstraction (PRD §11B, §15A)
- [ ] `packages/wallet-provider` with: getAddress, getBalance,
      signTransaction, signMessage, broadcastTransaction, capability
      discovery
- [ ] `packages/coinpay-wallet-provider` — CoinPay CLI implementation
- [ ] Direct EVM signer provider (fallback)
- [ ] Direct Solana signer provider (fallback)

---

## CEX adapters (PRD §6.1)

- [x] `@b1dz/adapters-cex` package wrapping PriceFeeds as VenueAdapters
- [x] Kraken adapter (observe-only wrapper; trading via existing
      source-crypto-arb live code for now)
- [x] Coinbase adapter
- [x] Binance.US adapter
- [x] Gemini adapter (observe-only — no trading credentials yet)
- [x] CEX taker-fee constants parity with live daemon
- [x] 6 unit tests covering buy/sell sides, slippage, fee overrides
- [ ] **Gemini trading credentials** — unlocks 283 pairs vs Binance.US's 6
- [ ] **Bitstamp** — price feed + trading creds. US-legal. 0.40% taker.
- [ ] **Bitfinex** — price feed + trading creds. Non-US retail only —
      legal review first. 0.20% / 0.10% taker.
- [ ] CEX order-book depth walker (MVP uses top-of-book + crude slippage)
- [ ] CEX submit-order + fill-status via adapter interface (currently lives
      in the v1 source-crypto-arb execution path)
- [ ] Balance fetch via adapter interface (wire into inventory ledger)

---

## EVM DEX / Aggregator adapters (PRD §6.2, §14.2, §15)

- [x] `@b1dz/adapters-evm` package with 0x and 1inch quote adapters
- [x] 0x quote adapter — `packages/adapters-evm/src/zeroex.ts`
- [x] 1inch quote adapter — `packages/adapters-evm/src/oneinch.ts`
- [x] Decimal <-> base-units helpers
- [ ] Direct Uniswap v3 integration on Base (PRD §14.5 ABI workflow)
      — proves the end-to-end contract path before Curve / Balancer
- [ ] Direct Curve integration
- [ ] Direct Balancer integration
- [ ] Trader Joe on Avalanche
- [ ] EVM pool graph + 2/3-hop route enumeration (PRD §12A) with
      configurable pruning
- [ ] Firm-quote / calldata fetch (not just indicative)
- [ ] Approval manager — detect allowance, exact vs safe policy, gas
      cost tracking, optional pre-approve via config (PRD §15.2)
- [ ] EIP-1559 gas strategy + max-gas thresholds + stale-quote
      rejection (PRD §15.3)
- [ ] Transaction simulation before send (PRD §15.4)
- [ ] Transaction submission + receipt tracking + failure classification
- [ ] Shared gas oracle replacing the hardcoded native-USD prices in the
      adapter

---

## Solana adapters (PRD §6.3, §14.3, §16)

- [x] `@b1dz/adapters-solana` package with Jupiter quote adapter —
      `packages/adapters-solana/src/jupiter.ts`
- [ ] Jupiter prepared-transaction fetch (not just quote)
- [ ] Solana wallet service — SPL token account awareness, SOL balance
      monitoring, keypair loading from env / secret manager
- [ ] Priority fee support + blockhash freshness validation
- [ ] Transaction confirmation handling + retry/re-sign policy
- [ ] Solana safety filters (PRD §16.3): mint allowlist, freeze-authority
      check, token-decimal verification, liquidity threshold, route
      complexity cap, stale-quote rejection
- [ ] Direct Raydium adapter (PRD §6.3 phase 2)
- [ ] Direct Orca adapter (phase 2)
- [ ] Meteora adapter (phase 2, if justified)

---

## Pump.fun (PRD §6.4, §14.4, §17)

- [ ] Pump.fun discovery adapter — detects new launches, bonding-curve
      state, migration events
- [ ] Lifecycle classifier: `new_launch` / `bonding_curve` / `migrating`
      / `pumpswap` / `external_pool`
- [ ] Rule engine + mode flag: `observe_only` / `paper_only` /
      `guarded_live` / `disabled` (default observe_only)
- [ ] Entry filters (PRD §17.2): routeable liquidity, acceptable
      spread/price-impact, volume velocity, unique activity, denylist,
      metadata presence, exit-route existence
- [ ] Exit rules (PRD §17.3): hard TP, hard SL, max hold time,
      liquidity-collapse detection, route-disappearance detection,
      price-impact-expansion detection, no discretionary holding
- [ ] Scrape fallback behind `PUMPFUN_ENABLE_SCRAPE` flag
- [ ] Direct PumpSwap adapter (phase 2)
- [ ] Direct Pump.fun program-aware quote adapter (phase 2)
- [ ] Migration-aware execution filter

---

## Phase 2 — Paper Trading (PRD §22.2, §23, §29 Phase 2)

- [ ] Paper execution simulator with modeled slippage, fees, gas,
      approval costs
- [ ] Pseudo execution receipts
- [ ] Expected vs simulated-realized outcome comparison
- [ ] Route replay logs (persist every quote snapshot for later replay)
- [ ] Comparison dashboard (expected vs actual per route)
- [ ] Pump.fun lifecycle event stream replay

### Backtesting (PRD §23.1)
- [ ] Historical CEX top-of-book / candle-derived replay (v1 backtest
      already does this — port into new adapter shape)
- [ ] Recorded DEX quote-snapshot replay
- [ ] Recorded gas and fee estimates where possible
- [ ] Modeled latency assumptions
- [ ] Metrics: gross PnL, net PnL, win rate, avg opp size, fill rate,
      failure rate, rejection rate, PnL by venue / chain / asset /
      route-type / token-lifecycle, Pump.fun exposure vs return

---

## Phase 3 — Live EVM Execution (PRD §29 Phase 3)

- [ ] Wallet service (depends on wallet-provider abstraction)
- [ ] Approval manager wired to live submissions
- [ ] Transaction builder
- [ ] Receipt tracker
- [ ] Kill switch controls wired to live EVM path

---

## Phase 4 — Live Solana Execution (PRD §29 Phase 4)

- [ ] Solana wallet service
- [ ] Jupiter prepared-tx signing + submission flow
- [ ] Confirmation tracking
- [ ] Priority fee controls
- [ ] Solana-specific safety filters enforced in live path

---

## Phase 5 — Guarded Pump.fun Execution (PRD §29 Phase 5)

- [ ] Pump.fun rule engine wired to live path
- [ ] Allowlist / denylist controls
- [ ] Forced time-based exit logic
- [ ] Tighter risk caps enforced
- [ ] PumpSwap awareness
- [ ] Migration-aware execution filter

---

## Phase 6 — Direct Venue Integrations (PRD §29 Phase 6)

- [ ] EVM: direct Uniswap, Curve, Balancer (see EVM section above for
      the single-venue prerequisite on Base)
- [ ] Solana: direct Raydium, Orca, optional Meteora
- [ ] Direct PumpSwap if justified

---

## Phase 7 — Advanced Strategies (PRD §29 Phase 7)

- [ ] DEX vs DEX route optimization
- [ ] Atomic route support where feasible
- [ ] Direct-venue vs aggregator edge testing
- [ ] AI-assisted route filtering (see AI roadmap below)
- [ ] Selective cross-chain opportunities

---

## LP bot for emission-paying pools (PRD §1)

LP is explicitly NOT in MVP (§4), but the architecture must leave room
for an LP-management track once trading-against-pools is solid. No
blind LP deployment — every decision must model emissions, volatility,
and unwind cost per §4 non-goal.

- [ ] Identify candidate emission-paying pools (Aerodrome on Base,
      Trader Joe on Avalanche, Raydium fusion pools, Orca whirlpools
      with rewards)
- [ ] Emissions-rate tracker — daily emissions per pool in reward
      token, USD-valued
- [ ] Impermanent-loss estimator based on current range + realized
      volatility
- [ ] Unwind-cost modeling (withdraw fees, LP token decay, claim
      gas)
- [ ] `expectedNetLpApr = emissionsApr + feesApr - ilApr - unwindCost`
      scoring model
- [ ] LP position inventory (ranges, current price vs range, unclaimed
      rewards)
- [ ] Auto-claim + auto-compound policy with gas-aware thresholds
- [ ] Concentrated-liquidity range management deferred to post-LP-MVP
      (§4 non-goal for now)
- [ ] Emergency unwind kill switch (liquidity collapse / exploit
      alert / stablecoin depeg on one side)

---

## Inventory ledger (PRD §21)

- [ ] Per-(venue, chain, token) balance tracking with: available,
      reserved, pending settlement, pending tx state, USD reference
      value
- [ ] Integration with every adapter's balance endpoint
- [ ] Honors capital-not-freely-movable rule (no assumed transfers
      mid-trade)

---

## Risk engine (PRD §25)

- [ ] Hard limits: max USD per trade / asset / chain, max daily loss,
      max per-venue loss, max gas per trade, max Solana fee, max
      slippage bps, max price impact bps
- [ ] Pump.fun limits (separate, tighter): smaller max USD, max hold
      time, max concurrent positions, max daily Pump.fun loss, max
      single-mint exposure, mandatory stop, mandatory TP or timed exit
- [ ] Kill switches (PRD §25.3): repeated tx failures, repeated CEX
      order failures, repeated stale-quote failures, chain congestion,
      RPC degradation, gas spike, wallet balance too low, approval
      stuck, realized loss threshold, Pump.fun liquidity collapse, too
      many Pump.fun stopouts in sequence

---

## Liquidity & safety filters (PRD §20)

- [ ] Global filters: net below threshold, stale quote, already executed
      recently, insufficient inventory, insufficient wallet balance,
      feature flag off, circuit breaker active
- [ ] DEX filters: price impact too high, too many hops, liquidity
      below threshold, token not allowlisted, gas/trade-size ratio too
      high, slippage too high, approval too expensive, venue down,
      aggregator confidence too low
- [ ] Solana filters: token not allowlisted, route too complex, fee
      spike, stale blockhash, Jupiter route quality below threshold,
      token-account setup exceeds trade value, low pool liquidity
- [ ] Pump.fun filters (PRD §20.4) — wired to Pump.fun entry logic
- [ ] CEX filters: order-book depth insufficient, spread too wide,
      withdrawals disabled, venue degraded

---

## Observability (PRD §24)

- [ ] Structured decision log: raw venue quote → normalized → profitability
      breakdown → rejection reasons → selected opportunity → execution
      metadata → tx hash / order id → confirmation status → realized
      outcome → post-trade variance vs estimate
- [ ] Pump.fun lifecycle state-change and migration-detection events
- [ ] Dashboards (PRD §24): quote counts per venue, opportunities by
      venue pair, approval costs over time, gas per chain, Solana fee
      trends, realized vs expected PnL, error rates, kill-switch
      events, Pump.fun watchlist quality, Pump.fun exits by reason
- [ ] Latency + health metrics per RPC / API provider
- [ ] Structured JSON logging across all services

---

## RPC & infrastructure (PRD §25A, §26)

- [ ] EVM: reliable primary RPC per chain, fallback RPC support,
      configurable timeouts, health checks, rate limiting, metrics per
      provider
- [ ] Solana: reliable primary + fallback RPC, WebSocket support, slot
      lag health checks, confirmation latency tracking
- [ ] Dockerized services
- [ ] Railway-friendly deployment configuration
- [ ] Optional isolated signer service
- [ ] Environment-based secret loading
- [ ] Self-hosted node strategy documented; not required for MVP but
      architecture allows for it when third-party RPC quality limits
      results

---

## Security (PRD §27)

- [ ] All signing server-side only; no private keys client-side
- [ ] Secrets encrypted at rest where possible
- [ ] Token allowlist enforced before any trade
- [ ] Block unknown token mints/contracts by default
- [ ] Global dry-run mode
- [ ] Emergency global disable switch
- [ ] Minimal sensitive data in logs
- [ ] Secret redaction in errors + traces
- [ ] Explicit flag required for scrape-based Pump.fun sources

---

## Trade modes (PRD §22)

- [ ] `MODE=observe` — quotes + opportunities logged, no paper fills
- [ ] `MODE=paper` — simulated fills with pseudo receipts
- [ ] `MODE=live` — real orders with strict caps + kill switch
- [ ] Pump.fun has its own mode flag separate from global MODE

---

## Config / env (PRD §32)

- [ ] Root `.env.example` with every PRD §32 variable documented
- [ ] `WALLET_PROVIDER=coinpay|direct-evm|direct-solana` selection
- [ ] `MIN_NET_PROFIT_USD` / `MIN_NET_PROFIT_BPS` / `MAX_GAS_USD` /
      `MAX_SLIPPAGE_BPS` / `MAX_ROUTE_HOPS` wired through the risk
      engine
- [ ] Pump.fun env flags: `PUMPFUN_MODE`, `PUMPFUN_ENABLE_SCRAPE`,
      `PUMPFUN_MAX_TRADE_USD`, `PUMPFUN_MAX_HOLD_SECONDS`,
      `PUMPFUN_MAX_CONCURRENT_POSITIONS`, `PUMPFUN_DAILY_MAX_LOSS_USD`

---

## AI roadmap (PRD §30) — deferred, NOT MVP

- [ ] Opportunity quality scoring
- [ ] Regime classification
- [ ] Anomaly detection
- [ ] Route failure prediction
- [ ] Gas spike forecasting
- [ ] Token risk pattern detection
- [ ] Post-trade winner/loser clustering
- [ ] Pump.fun launch quality scoring

Do NOT pursue: LLM-decides-trades, black-box next-tick prediction,
unguarded dynamic param changes, hype-driven buying.

---

## MVP acceptance gates (PRD §33)

Tracking: we're MVP-complete when every item below flips to [x].

- [ ] `b1dz observe` streams ranked live opportunities in real time
  (currently one-shot; needs loop + event channel)
- [ ] Trade daemon subscribes to those events and applies final
  execution decisions
- [ ] CoinPay CLI usable as wallet-provider implementation
- [~] Quotes from every enabled CEX venue — Kraken/Coinbase/Binance.US/Gemini
- [~] Quotes from 0x, 1inch, Jupiter (3 of 4 — Pump.fun discovery
  still pending)
- [x] All quotes in single normalized format
- [x] Profitability engine computes net expected value after all costs
- [~] Unsafe routes rejected with explicit reasons (basic blockers
  work; full safety filters still outstanding)
- [ ] Paper trading works for CEX, EVM, Solana, Pump.fun
- [ ] Live EVM execution works for allowed assets on enabled chains
- [ ] Live Solana execution works via Jupiter
- [ ] Pump.fun observe + paper mode by default
- [ ] Guarded Pump.fun live mode with tighter risk caps
- [ ] Inventory tracking across venues and chains
- [ ] Dashboards + logs explain accept/reject rationale
- [ ] Kill switch + hard risk limits enforced

---

## Repo structure vs PRD §31

PRD suggests:
```
/apps/{engine,api,dashboard}
/packages/{core,types,config,adapters-cex,adapters-evm,adapters-solana,
           adapters-pumpfun,wallet-provider,coinpay-wallet-provider,
           profitability,risk,paper-execution,live-execution,
           token-registry,observability}
```

What we actually have as of this TODO:
- [x] `/packages/venue-types` (PRD calls it `/types`; rename later)
- [x] `/packages/adapters-cex`
- [x] `/packages/adapters-evm`
- [x] `/packages/adapters-solana`
- [x] `/packages/profitability`
- [ ] `/packages/adapters-pumpfun`
- [ ] `/packages/wallet-provider`
- [ ] `/packages/coinpay-wallet-provider`
- [ ] `/packages/config`
- [ ] `/packages/token-registry` (currently embedded in adapter packages)
- [ ] `/packages/risk`
- [ ] `/packages/paper-execution`
- [ ] `/packages/live-execution`
- [ ] `/packages/observability`
- [ ] `/apps/engine` (new home for the observe loop + daemon; current
      CLI + daemon split isn't quite the PRD shape yet)
- [ ] `/apps/dashboard` (web dashboard per §24)
- [x] `/apps/api` (exists as Next.js in `/apps/web`)

---

## v1 remnants

- [x] v1 composite strategy + `b1dz backtest` live-disabled via `[d]`
      toggle
- [x] Existing TUI + daemon + supabase migrations stay as-is
- [x] Original CEX-only PRD archived at `PRD-v1-cex-analysis-engine.md`
- [ ] Eventually: migrate the v1 composite strategy into the new
      adapter/profitability framework so both trade-engine tracks live
      behind the same interface
