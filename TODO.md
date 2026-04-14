# TODO

Tracks PRD v6 build-out. Organized by PRD section / phase. The v1
composite-scalper engine stays in-tree but live-disabled via the `[d]`
TUI toggle while v6 is built alongside.

v6 adds two major addendums on top of the original PRD:
- **Addendum A**: execution realism, MEV, reachable retail edge —
  realizability scoring, execution-mode labels (public/private/bundle/
  paper_only), smaller-chain and long-tail focus, private-flow/bundle
  hooks, cross-chain lag windows
- **Addendum B**: anti-bagholder policy for TGEs, fresh listings, new
  pools, Pump.fun-style launches — observe-first, pre-validated exit,
  time-based kill, dump-protection signals, no-average-down

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
- [x] `b1dz observe` CLI — one-shot quote + rank pass.
      See `apps/cli/src/observe.ts`
- [x] Streaming observe loop — continuous quote cycle emitting events.
      See `packages/observe-engine/src/index.ts` (commit b28c255)
- [x] Event channel — in-memory + Supabase-backed queue.
      See `packages/event-channel/src/` (commit b28c255)
- [x] Trade daemon: subscribes to events, applies final risk+balance
      checks, decides execute / paper / reject.
      See `packages/trade-daemon/src/index.ts` (commit 93fdf50)
- [ ] Top-N live opportunity feed (ranked view, not just raw stream)
- [ ] Health/latency metrics per venue surfaced to the operator
- [ ] Redis/NATS event-channel option (currently Supabase + in-memory
      only — fine for MVP, revisit if latency matters)

### Wallet provider abstraction (PRD §11B, §15A)
- [x] `packages/wallet-provider` interface: getAddress, getBalance,
      signTransaction, signMessage, broadcastTransaction, capability
      discovery. See `packages/wallet-provider/src/index.ts`
      (commit 51bef3f)
- [x] `packages/wallet-coinpay` — CoinPay CLI implementation
      (commit 51bef3f)
- [x] Direct EVM signer provider (viem-backed) —
      `packages/wallet-direct/src/evm.ts`. Signs digests + EIP-191
      messages with a raw secp256k1 private key for server-daemon
      non-interactive signing
- [x] Direct Solana signer provider (pure Node crypto, no `@solana/web3.js`
      dep) — `packages/wallet-direct/src/solana.ts`. Accepts
      solana-keygen JSON / hex / base58 secrets, validates embedded
      pubkey, ed25519-signs via PKCS8 DER import

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
- [x] Direct Uniswap v3 quote adapter on Base (PRD §14.5 ABI workflow)
      — `packages/adapters-evm/src/uniswap-v3.ts` (commit 8737b9c).
      Proves end-to-end contract path before Curve / Balancer
- [ ] Uniswap v3 execution path (quote works; swap-submit + receipt
      tracking still open — belongs in Phase 3 live-EVM)
- [ ] Direct Curve integration
- [ ] Direct Balancer integration
- [ ] Trader Joe on Avalanche
- [ ] EVM pool graph + 2/3-hop route enumeration (PRD §12A) with
      configurable pruning
- [ ] Firm-quote / calldata fetch (not just indicative)
- [x] Approval manager (PRD §15.2) — `packages/adapters-evm/src/approvals.ts`:
      `readAllowance`, `checkApproval`, `buildApprovalTx`,
      `safeApproveCalls` (USDT zero-first pattern), `approvalCostKillsEdge`
      profitability gate, `exact` / `unlimited` modes
- [x] EIP-1559 gas strategy (PRD §15.3) —
      `packages/adapters-evm/src/gas.ts`: `ViemGasOracle` over a viem
      `PublicClient`, `estimateTxCostUsd` (with bps buffer), stale-fee
      rejection, `exceedsGasBudget` + `gasEatsTheEdge` gates, `isGasSpike`
      baseline comparator
- [x] Wire gas oracle into `UniswapV3Adapter.quote()` — adapter now
      accepts optional `gasOracle`, `nativeUsd` resolver, and
      `gasBufferBps` (default 2000 bps / +20% EIP-1559 safety margin).
      Falls back to the old 1-gwei hardcoded path when unwired.
      `ViemGasOracle` got TTL-based caching + in-flight coalescing so
      per-quote RPC overhead is bounded
- [ ] Wire gas oracle into 0x + 1inch adapters (same pattern)
- [ ] Wire approval manager into live-EVM execution path (module
      exists; no caller yet because live execution isn't assembled)
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

- [x] Pump.fun discovery adapter + `b1dz pumpfun discover` CLI —
      `packages/adapters-pumpfun/src/discovery.ts` (commit 5b04bb3)
- [x] Lifecycle classifier: `new_launch` / `bonding_curve` / `migrating`
      / `pumpswap` / `external_pool` —
      `packages/adapters-pumpfun/src/lifecycle.ts` (commit 5b04bb3)
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

- [~] Wallet service — `wallet-provider` abstraction + CoinPay and
      direct-EVM/Solana implementations shipped; still need a
      coordinating "wallet service" that picks provider per operation
      and caches addresses
- [~] Approval manager — module shipped in `packages/adapters-evm/`,
      not yet wired into live submission flow
- [x] Transaction builder — `packages/adapters-evm/src/tx-builder.ts`:
      `buildUnsignedTx` (pure, validates chain/nonce/gas),
      `digestForSigning` (keccak256 of RLP-encoded EIP-1559 payload
      for `WalletProvider.signDigest()`), `assembleSignedTx`
      (reassembles r/s/v sig into broadcast-ready serialized tx).
      Round-trip tested via viem's `parseTransaction` +
      `recoverTransactionAddress`
- [x] Receipt tracker — `packages/adapters-evm/src/receipts.ts`:
      `trackReceipt()` polls `eth_getTransactionReceipt` with
      configurable interval + hard timeout, tolerates viem's
      `TransactionReceiptNotFoundError` while pending, classifies
      outcome as `success` / `reverted` / `timeout`.
      `outcomeToStatus()` maps to the event-channel terminal-status
      vocabulary (`filled` / `reverted` / `stuck`)
- [ ] Wallet-service layer that orchestrates build → digest → sign →
      assemble → broadcast → trackReceipt using a `WalletProvider`
      implementation and a `PublicClient`
- [ ] Nonce manager (per-chain, per-wallet; persisted so a restart
      doesn't nonce-collide)
- [ ] Kill switch controls wired to live EVM path (repeated tx
      failures → disable, gas spike → pause)

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

- [x] `b1dz observe` streams ranked live opportunities in real time
  (commit b28c255)
- [x] Trade daemon subscribes to those events and applies final
  execution decisions (commit 93fdf50)
- [x] CoinPay CLI usable as wallet-provider implementation
  (commit 51bef3f)
- [~] Quotes from every enabled CEX venue — Kraken/Coinbase/Binance.US/Gemini
- [x] Quotes from 0x, 1inch, Jupiter, Pump.fun discovery
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
- [x] `/packages/adapters-pumpfun`
- [x] `/packages/wallet-provider`
- [x] `/packages/wallet-coinpay` (PRD calls it `coinpay-wallet-provider`
      — rename later)
- [x] `/packages/wallet-direct` (direct EVM + Solana signers,
      fallback to CoinPay)
- [x] `/packages/event-channel` (not in PRD §31 but needed for the
      observe/daemon split)
- [x] `/packages/observe-engine`
- [x] `/packages/trade-daemon`
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

---

## Addendum A — Execution realism, MEV, reachable retail edge (PRD §A1–A16)

Core thesis update: realizability, not Node.js perf, is the bottleneck.
An opportunity must score well on *both* theoretical profit and
practical realizability before the daemon will act on it.

### Realizability scoring layer (PRD §A3, §A6)
- [x] Extend `Opportunity` type with `OpportunityExecutionMeta`:
      `realizabilityScore`, `mevRiskScore`, `latencyRiskScore`,
      `requiresPrivateFlow`, `recommendedExecutionMode`,
      `simulationNotes[]` — `packages/venue-types/src/index.ts`
- [x] `ExecutionMode` union: `"public" | "private" | "bundle" | "paper_only"`
- [x] Heuristic scoring module `scoreExecutionMeta()` — MVP-grade
      (flags mainnet dex↔dex as private, pump.fun as paper_only,
      expired quotes + multi-hop routes downgraded)
- [x] `buildOpportunity()` now auto-populates `execution` via the scorer
- [ ] Proper simulator-driven scoring to replace heuristic (PRD §A8)

### `b1dz observe` realizability duties (PRD §A4)
- [ ] Classify mempool exposure risk per route
- [ ] Classify backrun / sandwich exposure risk
- [ ] Estimate whether private flow or bundling is required
- [ ] Tag each opportunity with recommended execution mode before it
      hits the event channel

### Trade daemon execution-mode policy (PRD §A5)
- [x] Reject opportunities that are profitable only in a frictionless
      model (realizability threshold in `RiskLimits.minRealizabilityScore`)
- [x] Refuse public execution for routes marked private-only or
      bundle-only (`canSatisfy()` + `executionMode` config)
- [x] Apply execution-mode policy before tx submission
- [x] Extra skepticism gate for major-chain public-mempool routes
      (`rejectPublicMevAbove` threshold)

### Realizability filters (PRD §A7)
- [ ] Reject: route requires private/bundle but only public flow is
      available
- [ ] Reject: estimated backrun risk too high
- [ ] Reject: estimated sandwich risk too high
- [ ] Reject: detection-to-submit latency > `MAX_DETECTION_TO_SUBMIT_MS`
- [ ] Reject: simulated adverse selection erases most or all edge
- [ ] Reject: route complexity makes the timing window unrealistic
- [ ] Downgrade: public-mempool post would likely convert profit to loss

### Simulation layer (PRD §A8)
- [ ] Pre-trade route simulation with slippage + gas modeling
- [ ] Latency-aware price-movement model
- [ ] Adverse-selection model
- [ ] Side-by-side public vs private vs bundled execution assumptions
- [ ] Post-trade variance analysis: expected vs realized

### Strategy priority update (PRD §A9)
Preferred first, in order:
- [ ] Smaller-chain new-pool monitoring (§A10)
- [ ] Long-tail pair monitoring (§A11)
- [ ] Guarded cross-chain lag strategies (§A12)
- [ ] Private-flow / bundled execution support (§A13)
- [ ] Public-mempool DEX routes — only when simulations show they
      remain realistic
- [ ] Do **not** prioritize beating pro MEV shops on obvious mainnet
      triangular routes

### New-pool launch monitoring (PRD §A10)
- [ ] New pool discovery on smaller chains (Base, Avalanche first)
- [ ] First-24h and first-48h monitoring windows
- [ ] Liquidity + routeability scoring per new pool
- [ ] Watchlist promotion flow: observe → paper → guarded_live
- [ ] Strict size caps for launch-related strategies

### Long-tail pair monitoring (PRD §A11)
- [ ] Minimum-liquidity thresholds per pair
- [ ] Maximum position caps
- [ ] Validated exit routes before entry
- [ ] Stricter bag-holder prevention rules (hook into Addendum B policy)
- [ ] Paper-mode-first promotion path

### Cross-chain lag windows (PRD §A12)
- [ ] Finality-lag detection per supported chain pair
- [ ] Explicit capital + settlement assumption modeling
- [ ] Replay + paper modeling must exist before any live cross-chain
- [ ] Opt-in strategy activation
- [ ] Lower-than-normal risk caps

### Execution infrastructure (PRD §A13)
- [ ] Private-relay integration hook (Flashbots Protect / MEV-Share /
      equivalent) — architecture only for MVP
- [ ] Bundle-submission hook
- [ ] Separate quote RPC vs execution RPC configurability
- [ ] Self-hosted / lower-latency node option when provider quality
      limits results

### Config additions (PRD §A14)
- [ ] `EXECUTION_MODE=public|private|bundle|paper_only`
- [ ] `PRIVATE_FLOW_ENABLED=false`
- [ ] `BUNDLE_EXECUTION_ENABLED=false`
- [ ] `MAX_DETECTION_TO_SUBMIT_MS=500`
- [ ] `REJECT_PUBLIC_HIGH_MEV_ROUTES=true`

### Acceptance (PRD §A15)
- [ ] Realizability scored separately from raw profitability
- [ ] Opportunities labeled public / private / bundle / paper_only
- [ ] Daemon refuses routes viable only in unavailable execution modes
- [ ] Simulations include adverse-execution assumptions, not just fees
      and slippage

---

## Addendum B — Anti-bagholder policy for new tokens / TGEs / fresh pools (PRD §B1–B15)

b1dz must never become exit liquidity for insiders, unlock recipients,
airdrop farmers, or early launch traders. For fresh tokens b1dz is a
short-horizon scanner with pre-validated exits — not a thesis investor.

### Core policy wrapper (PRD §B3, §B4, §B5)
- [ ] Strategy class `anti_bagholder_new_token_policy` wrapping every
      new-token strategy; overrides execution when risk is too high
- [ ] Default mode for any token with limited live history:
      observe_only → paper_only → guarded_live (explicit promotion only)
- [ ] Hard rules: tiny max size, pre-defined exit plan before entry,
      mandatory stop-loss, mandatory TP or timed exit, max hold in
      minutes/hours not days
- [ ] No averaging down, no martingale, no "wait for recovery"
- [ ] No add after first failed breakout unless explicitly requalified
- [ ] No live trade unless exit venue is already validated

### Token lifecycle risk filter (PRD §B6)
- [ ] Classify: token age, pool/listing age, unlock phase (pre / mid /
      post), insider/airdrop distribution risk, supply expansion rate,
      current liquidity depth for exit, route durability post-entry
- [ ] Unknown or unstable lifecycle → force observe_only or paper_only

### TGE / fresh listing policy (PRD §B7)
- [ ] No market-buy at first print
- [ ] Require post-launch observation window
- [ ] Minimum liquidity threshold gate
- [ ] Validated exit route gate
- [ ] Adverse-move tolerance test in simulation
- [ ] Prefer scalps and dislocations over holds

### Exit-first architecture (PRD §B8)
- [ ] Entry rejected unless engine can answer: where we exit, how fast,
      expected exit slippage, behavior if liquidity drops 25% / 50%,
      whether a second exit venue exists, CEX deposit/withdraw status
- [ ] Low exit certainty → reject

### Time-based kill switch (PRD §B9)
- [ ] Scalp mode: max hold 60–300s
- [ ] Guarded-live mode: max hold 15–120 min
- [ ] Never auto-carry into the next major unlock window
- [ ] At max hold: exit / reduce aggressively / mark strategy failed
      and block re-entry until requalified

### Dump-protection signals (PRD §B10)
- [ ] Liquidity drops sharply → reduce/exit
- [ ] Price impact rises sharply → reduce/exit
- [ ] Spread widens abnormally → reduce/exit
- [ ] Route disappears → exit
- [ ] CEX deposit/withdraw status changes → exit
- [ ] Large sell pressure on active venue → exit
- [ ] Unlock or emissions event near → exit
- [ ] Post-entry slippage exceeds expected band → exit
- [ ] Volume one-sided to the downside → exit
- [ ] Dead-cat-bounce pattern after sharp dump → block re-entry

### No-emotion re-entry (PRD §B11)
- [ ] Blocks automatic revenge trades
- [ ] Blocks rebuy purely on lower price
- [ ] Re-entry requires: new setup, fresh liquidity validation, fresh
      exit validation, fresh risk score, cooldown period elapsed

### Allowed vs disallowed strategies (PRD §B12)
Allowed (tiny size only):
- [ ] DEX ↔ CEX dislocation trades
- [ ] Post-launch route mismatches
- [ ] Early-listing spread capture
- [ ] First-24h/48h monitored opportunities
- [ ] Paper-only watch on new launches until promoted

Blocked by default:
- [ ] Blind launch sniping
- [ ] Hold-and-hope
- [ ] Averaging into weakness
- [ ] Influencer-driven buys
- [ ] Holding through unlocks

### Config additions (PRD §B13)
- [ ] `NEW_TOKEN_MODE=observe_only`
- [ ] `NEW_TOKEN_MAX_TRADE_USD=25`
- [ ] `NEW_TOKEN_MAX_HOLD_SECONDS=300`
- [ ] `NEW_TOKEN_REQUIRE_EXIT_VALIDATION=true`
- [ ] `NEW_TOKEN_REQUIRE_SECONDARY_EXIT=false`
- [ ] `NEW_TOKEN_NO_AVERAGE_DOWN=true`
- [ ] `NEW_TOKEN_COOLDOWN_MINUTES=30`
- [ ] `NEW_TOKEN_STOP_LOSS_BPS=300`
- [ ] `NEW_TOKEN_TAKE_PROFIT_BPS=500`
- [ ] `NEW_TOKEN_FORCE_EXIT_ON_LIQUIDITY_DROP=true`
- [ ] `NEW_TOKEN_FORCE_EXIT_ON_ROUTE_LOSS=true`

### Acceptance (PRD §B14)
- [ ] New tokens default to observe or paper mode
- [ ] Live mode for fresh tokens requires explicit promotion
- [ ] Every fresh-token trade has a pre-validated exit plan
- [ ] Daemon refuses to hold past configured max-hold windows
- [ ] Averaging down is blocked by policy
- [ ] Dump-protection signals can force immediate exit
- [ ] Re-entry requires cooldown and full requalification

---

## v6 cross-cutting follow-ups

- [ ] Rename `packages/wallet-coinpay` → `packages/coinpay-wallet-provider`
      to match PRD §31 (low priority — cosmetic)
- [ ] Rename `packages/venue-types` → `packages/types` (PRD §31)
- [ ] Document the execution-mode + realizability-score contract in the
      `packages/venue-types` README so new adapters know what to emit
- [ ] Reconcile `OpportunityExecutionMeta` fields with existing
      `Opportunity` type without breaking the trade daemon consumer
