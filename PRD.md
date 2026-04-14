# PRD.md

# b1dz DEX + Liquidity Pool Support PRD
## With Solana and Pump.fun Support From Day One

## 1. Overview

Build a new DEX and liquidity-pool trading layer for b1dz so the arbitrage bot can operate across both centralized exchanges and onchain venues from day one, with a deliberate shift in emphasis toward DeFi where fragmented liquidity and route mismatch opportunities are more likely to exist than on major centralized exchanges.

The current b1dz bot supports centralized exchanges only:
- Coinbase
- Gemini
- Kraken
- Binance.US

These venues remain useful for reference pricing, inventory parking, fiat access, and CEX/DEX comparison, but the PRD now assumes the strongest long-term edge is more likely to come from DeFi routing and pool fragmentation rather than simple major-exchange CEX arbitrage.

This project adds:
- EVM DEX routing and swap execution
- Solana DEX routing and swap execution
- liquidity-pool quote ingestion
- Pump.fun discovery, quote monitoring, and guarded execution support
- unified profitability modeling across CEX and DEX venues
- paper trading and backtesting support for onchain routes
- production-safe live execution with strict risk controls

The goal is not to start as a liquidity provider in MVP. The primary goal is to trade against onchain liquidity pools and aggregators in order to unlock more fragmented and potentially more profitable opportunity surfaces than are available on large centralized exchanges alone. A secondary explicit goal is to leave room for LP-management automation as a later strategy track on EVM chains once pool interactions, contracts, and execution behavior are well understood.

This PRD is for Claude Code and should be treated as an implementation blueprint.

## 2. Product Goal

Enable b1dz to detect and execute profitable arbitrage and short-term routing opportunities across:
- CEX to CEX
- CEX to DEX
- DEX to DEX
- single-chain multi-pool arbitrage on EVM chains
- multi-hop route arbitrage on EVM chains
- Pump.fun bonding curve opportunities
- Pump.fun to PumpSwap opportunities
- Pump.fun ecosystem to Raydium / Orca / Jupiter routes where supported
- single-chain routed swaps
- eventually selected cross-chain opportunities

The system must support Solana from the initial release, not as a later add-on.

## 3. Core Principles

- Venue-agnostic architecture
- All-in profitability accounting
- Deterministic execution logic
- Strict risk controls
- Small-size live rollout first
- Quote normalization across chains
- Backtest parity where practical
- No blind trust in aggregator output
- Do not start by providing liquidity
- Start by quoting and swapping against pools
- Treat Pump.fun tokens as high-risk unless proven otherwise
- Favor survivability over aggressiveness

## 4. Non-Goals

- No LP farming or LP provisioning in MVP
- No automated concentrated-liquidity management in MVP
- No fully autonomous cross-chain bridge arbitrage in MVP
- No flash-loan arbitrage in MVP
- No memecoin-first strategy in MVP outside guarded Pump.fun support
- No AI-based trade placement in MVP
- No blind buying of fresh Pump.fun launches without filters

## 5. Why This Exists

Simple arbitrage across major centralized exchanges is highly competitive and often unprofitable after:
- fees
- spread
- latency
- withdrawal constraints
- transfer delays
- capital fragmentation

Onchain liquidity pools create a wider opportunity surface:
- more venues
- more fragmented liquidity
- many pools for the same base pair on one chain
- more routing variation
- more stale pricing in some pools
- more stablecoin route differences
- more long-tail asset opportunities
- more combinatorial arbitrage paths when multiple pools and multi-hop routes are considered

But onchain trading also introduces:
- gas fees
- slippage
- approval flows on EVM
- transaction failure risk
- MEV risk
- RPC latency and reliability issues
- token risk
- smart contract risk

Gas must be modeled everywhere, but the PRD now distinguishes between:
- high-gas environments where gas can dominate edge, especially Ethereum mainnet
- lower-cost EVM environments where gas is still real but often less likely to be the primary blocker for moderate-size opportunities

Pump.fun adds another opportunity surface, but with even higher risk:
- extreme volatility
- shallow or rapidly changing liquidity
- bot-heavy flows
- social hype decay
- rug / abandonment risk
- bag-holder risk
- route and venue transitions during token lifecycle

Therefore b1dz needs a formal onchain execution architecture, not just a few swap scripts.

## 6. Supported Venue Types

### 6.1 CEX
Existing:
- Coinbase
- Gemini
- Kraken
- Binance.US

### 6.2 EVM DEX / Aggregator Support
MVP:
- 0x
- 1inch
- at least one direct AMM integration on an EVM chain for contract-level learning and execution validation

Phase 2 direct venues:
- Uniswap
- Curve
- Balancer
- Trader Joe on Avalanche
- additional chain-native DEXes as justified by observed opportunity density

### 6.3 Solana Support
MVP:
- Jupiter aggregator

Phase 2 direct venues:
- Raydium
- Orca
- Meteora or other major Solana liquidity venues as needed

### 6.4 Pump.fun Ecosystem Support
MVP:
- Pump.fun token discovery
- Pump.fun bonding-curve state monitoring
- PumpSwap route awareness
- Jupiter route comparison for supported assets
- scrape or stream metadata only where officially supported APIs are absent or incomplete

Phase 2:
- direct PumpSwap adapter
- direct Pump.fun program-aware quote adapter
- migration detection from bonding curve to downstream venue
- strategy module specialized for launch / post-launch behavior

## 7. Chains

### 7.1 EVM Chains
MVP recommended:
- Base
- Avalanche
- Ethereum for reference and selective execution only

Optional later:
- Arbitrum
- Optimism
- Polygon
- BNB Chain

Avalanche is specifically called out because DeFi pool fragmentation there may create many same-pair pool combinations and route permutations worth scanning.

### 7.2 Solana
MVP required:
- Solana mainnet-beta

## 8. Product Requirements

The system must:
- ingest quotes from CEXs, EVM aggregators, EVM DEXs, Solana aggregators, and Pump.fun-related venues
- explicitly support multiple pools for the same pair on the same chain
- explicitly support multi-hop route enumeration on EVM chains
- normalize quotes into one canonical format
- calculate all-in profitability before execution
- support paper trading for onchain routes
- support live EVM swap execution
- support live Solana swap execution
- manage EVM token approvals safely
- manage Solana token account requirements
- estimate gas, fees, and slippage
- model route complexity and execution risk
- reject unsafe or low-quality opportunities
- track inventory by venue and chain
- log every quote, decision, and execution outcome
- support backtesting and replay where feasible
- support strict Pump.fun allowlists and launch filters
- support Pump.fun kill switches and exposure caps

## 9. Core User Story

As the operator of b1dz, I want to compare centralized exchange prices with onchain swap quotes on both EVM chains and Solana, including Pump.fun ecosystem routes, so that I can identify and execute profitable routes that still work after all costs and execution risks are applied.

## 10. Strategy Scope

The MVP should support these opportunity classes:

### 10.1 CEX -> DEX Arbitrage
Example:
- buy on Coinbase
- sell via Uniswap route on Base
or:
- buy on Kraken
- sell via Jupiter on Solana

### 10.2 DEX -> CEX Arbitrage
Example:
- buy via 0x on Base
- sell on Binance.US

### 10.3 DEX -> DEX Arbitrage On Same Chain
Example:
- buy through direct Uniswap route
- sell through Curve route
or:
- buy through Orca
- sell through Raydium
or:
- compare many same-pair pools on Avalanche such as multiple AVAX/USDC pools and evaluate all viable pairwise and routed combinations

### 10.4 Aggregator vs Direct Venue Comparison
Compare:
- 0x quote
- 1inch quote
- direct Uniswap quote
- direct Curve quote
- direct Balancer quote
- Jupiter route
- direct Raydium quote
- direct Orca quote
- direct PumpSwap quote when available

### 10.5 Pump.fun Specialized Opportunities
- early discovery and paper scoring only for brand-new launches
- bonding curve momentum observation
- post-migration route comparison
- Pump.fun / PumpSwap vs Raydium / Orca / Jupiter comparison where routable
- fast-entry / faster-exit scalps only under strict exposure limits
- immediate reject if token fails safety and liquidity filters

## 11. Out of Scope for MVP Strategy
- flash-loan atomic arbitrage
- sandwich or MEV extraction
- liquidity providing
- rebalancing concentrated LP ranges
- bridging capital mid-trade
- fully automated long-tail token speculation
- unlimited memecoin chasing
- averaging down on failing Pump.fun names

## 11A. Runtime Model: Observe Command and Trade Daemon

b1dz must be split into two coordinated runtime components:

### 11A.1 `b1dz observe`
The `b1dz observe` command is a real-time opportunity scanner.

Responsibilities:
- connect to all enabled data sources
- watch CEX books, DEX quotes, pool states, and Pump.fun lifecycle events
- enumerate candidate opportunities
- compute all-in profitability
- rank opportunities by expected net profit and confidence
- continuously stream the best opportunities to the server-side trade engine
- never place trades directly in its default production role

Outputs:
- structured opportunity events
- profitability breakdowns
- reject reasons
- top-N live opportunity feed
- health and latency metrics by venue

### 11A.2 Trade Engine Daemon
The trade engine runs as a daemon on the server.

Responsibilities:
- subscribe to opportunity events from `b1dz observe`
- apply final risk checks, balance checks, and feature flags
- decide whether to execute, paper trade, or reject
- manage execution state, retries, confirmations, and receipts
- update inventory and realized PnL
- expose kill-switch control and audit logs

The observe process and trade daemon must communicate through a durable internal event channel such as:
- Redis streams
- NATS
- Postgres queue
- or another reliable message bus

The boundary between them must be explicit:
- observe finds and scores
- daemon decides and executes

## 11B. CoinPay CLI and Web Wallet Integration

Because b1dz already has CoinPay web wallet infrastructure, the PRD should support using CoinPay CLI and related wallet flows as the operational bridge into onchain execution.

Goals:
- reuse existing wallet and signing infrastructure where practical
- avoid inventing a second disconnected wallet stack unless required
- make b1dz capable of requesting balances, addresses, and signing flows through CoinPay-compatible interfaces

Recommended integration pattern:
- b1dz adapters request wallet actions through a wallet-provider abstraction
- one implementation of that abstraction is CoinPay CLI
- other implementations may include direct private-key signers or chain-specific SDK signers

Suggested responsibilities for the CoinPay CLI wallet provider:
- return chain addresses for configured wallets
- report balances for supported assets
- sign EVM transactions
- sign Solana transactions if supported by CoinPay wallet flows, otherwise fall back to a Solana-specific signer
- manage or proxy web-wallet session/auth flows where relevant
- keep private key material out of the b1dz app process when possible

The PRD should treat CoinPay CLI as the preferred wallet bridge for:
- web wallet interoperability
- existing operational consistency
- future user-facing wallet features

But the architecture must remain pluggable because:
- some DEX integrations may need direct low-level chain SDK access
- Solana support may require a dedicated signer path even if CoinPay handles EVM well
- server daemon execution may need non-interactive signing behavior distinct from browser wallet UX

## 12. System Architecture

The architecture must be modular and venue-agnostic.

## 12A. EVM Pool Graph and Route Enumeration

For EVM chains, the engine must maintain a pool graph where:
- nodes are tokens
- edges are pools or executable swap venues
- multiple edges may exist for the same token pair

The route engine must:
- enumerate same-pair multi-pool comparisons
- enumerate 2-hop and 3-hop routes under strict complexity limits
- score routes by expected net value after gas, slippage, and price impact
- avoid combinatorial explosion with configurable pruning rules


### 12.1 Major Modules
- market data service
- quote service
- venue adapter layer
- token metadata registry
- chain config registry
- route profitability engine
- risk engine
- paper trading engine
- live execution engine
- wallet and signer service
- wallet-provider abstraction with CoinPay CLI implementation
- inventory ledger
- Pump.fun discovery watcher
- Pump.fun lifecycle classifier
- observability and logging service
- backtest/replay engine
- admin config and feature flag layer

### 12.2 High-Level Flow
1. request quotes from all enabled venues
2. ingest Pump.fun discovery / lifecycle events
3. normalize all quotes and token metadata
4. compute all-in profitability
5. run safety and liquidity checks
6. rank viable opportunities
7. paper trade or live execute depending on mode
8. track confirmations and fills
9. update inventory and logs
10. evaluate post-trade PnL

## 13. Canonical Data Model

All venues must map into a shared quote shape.

```ts
export type NormalizedQuote = {
  venue: string
  venueType: "cex" | "dex" | "aggregator" | "launchpad"
  chain: string | null
  dexProtocol?: string | null
  pair: string
  baseAsset: string
  quoteAsset: string
  amountIn: string
  amountOut: string
  amountInUsd?: string | null
  amountOutUsd?: string | null
  side: "buy" | "sell"
  estimatedUnitPrice: string
  feeUsd: string
  gasUsd: string
  slippageBps: number
  priceImpactBps?: number | null
  routeHops: number
  routeSummary: string[]
  quoteTimestamp: number
  expiresAt?: number | null
  latencyMs?: number | null
  allowanceRequired?: boolean | null
  approvalToken?: string | null
  tokenLifecycle?: "new_launch" | "bonding_curve" | "migrating" | "pumpswap" | "external_pool" | null
  raw: unknown
}
```

All opportunities must map into a shared route shape.

```ts
export type Opportunity = {
  id: string
  buyVenue: string
  sellVenue: string
  buyChain: string | null
  sellChain: string | null
  asset: string
  size: string
  grossEdgeUsd: string
  totalFeesUsd: string
  totalGasUsd: string
  totalSlippageUsd: string
  riskBufferUsd: string
  expectedNetUsd: string
  expectedNetBps: number
  confidence: number
  blockers: string[]
  executable: boolean
  category: "cex_cex" | "cex_dex" | "dex_dex" | "pumpfun_scalp" | "pumpfun_migration" | "pumpfun_post_migration"
}
```

## 14. Venue Adapter Requirements

Each adapter must implement:
- health check
- authentication or wallet setup
- token/pair support discovery
- quote fetch
- execution preparation
- execution submit
- execution status check
- error normalization
- rate limiting
- retry policy
- structured logging

### 14.1 CEX Adapter Interface
- fetch order book or top-of-book
- fetch effective fill estimate for target size
- submit order if enabled
- fetch fill status
- fetch balances

### 14.1.1 CEX Market-Type Rules
- distinguish spot from perps explicitly
- never compare spot and perp prices as if they were identical without funding / basis logic
- tag every CEX quote with market type
- keep perp support out of scope unless a dedicated basis or funding-aware module is added


### 14.2 EVM Adapter Interface
- fetch quote
- fetch firm quote or calldata
- estimate gas
- validate allowance
- build approval transaction if needed
- simulate where possible
- submit transaction
- track receipt
- classify failure

### 14.3 Solana Adapter Interface
- fetch quote
- fetch prepared swap transaction or instructions
- estimate fees
- validate token account readiness
- sign and send transaction
- confirm transaction
- classify failure

### 14.4 Pump.fun Adapter Interface
- detect new launches or newly relevant tokens
- fetch bonding curve state if applicable
- infer token lifecycle state
- discover downstream routing venue availability
- fetch quote or indicative price when possible
- classify unsupported / unsafe states
- expose migration or graduation signals
- support scrape fallback only behind feature flag

### 14.5 EVM Contract Discovery and ABI Workflow
- for at least one direct EVM DEX integration, inspect real swap and liquidity transactions
- capture relevant contract addresses from transaction traces or logs
- retrieve and store verified ABIs when available
- generate typed contract clients from ABIs
- separate router, pair/pool, factory, and helper contracts in the adapter design
- support a developer workflow for learning new pools by tracing a known deposit or swap transaction end to end


## 15. EVM-Specific Requirements

### 15.1 Wallet Support
- per-chain wallet configuration
- support dedicated hot wallet
- secure private key loading through env or secret manager
- nonce management
- balance checks before execution

### 15.2 Approvals
- detect allowance requirement
- support approve-exact or safe approval policy
- track approval gas cost
- optionally pre-approve commonly used tokens only via explicit config
- reject routes that require approval when approval cost kills edge

### 15.3 Gas Strategy
- support EIP-1559 fee modeling
- configurable max gas thresholds
- gas buffer for volatile periods
- stale gas quote rejection

### 15.4 Simulation
- where possible, simulate swap transaction before send
- reject on obvious failure cases
- store simulation diagnostics

## 15A. Wallet Provider Abstraction

All execution paths must go through a wallet-provider abstraction rather than coupling adapters directly to raw keys.

Required interface areas:
- getAddress(chain)
- getBalance(chain, asset)
- signTransaction(chain, payload)
- signMessage(chain, payload) where needed
- broadcastTransaction(chain, signedPayload) when supported
- capability discovery by chain

Implementations:
- CoinPay CLI wallet provider
- direct EVM signer provider
- direct Solana signer provider

Rules:
- prefer CoinPay CLI where it provides a clean server-safe path
- keep Solana signer support pluggable in case CoinPay coverage is incomplete
- never hardcode wallet logic into venue adapters

## 16. Solana-Specific Requirements

### 16.1 Wallet Support
- dedicated Solana hot wallet
- secure keypair loading through env or secret manager
- SOL balance monitoring for transaction fees
- SPL token account awareness

### 16.2 Quote and Execution
- Jupiter quote integration from MVP
- support prepared transaction flow
- slippage configuration per route
- optional priority fee support
- blockhash freshness validation
- transaction confirmation handling
- transaction retry or re-sign policy where safe

### 16.3 Solana Safety Checks
- token mint allowlist for MVP
- freeze authority / mint risk awareness where available
- token decimal verification
- liquidity threshold filter
- route complexity filter
- stale quote rejection

## 17. Pump.fun Strategy Guardrails

Pump.fun support must be opt-in and heavily restricted.

### 17.1 MVP Pump.fun Rules
- default to observe mode only
- default to paper trading for fresh launches
- require manual enablement for live trading
- require token allowlist or rule-based allowlist
- require min liquidity / routeability
- require max holding time
- require hard stop loss
- require max position size much smaller than majors
- never average down automatically
- never hold because of social hype alone

### 17.2 Pump.fun Entry Filters
A Pump.fun candidate must pass:
- sufficient routeable liquidity
- acceptable spread / price impact
- sufficient volume velocity
- enough unique activity to avoid totally dead launches
- not flagged by denylist
- token metadata present enough to classify
- execution venue actually reachable
- estimated exit path exists before entry

### 17.3 Pump.fun Exit Rules
For Pump.fun live mode:
- predefined take-profit ladder or hard take-profit
- predefined stop-loss
- predefined max hold time
- immediate exit on liquidity collapse signal
- immediate exit on route disappearance
- immediate exit on severe price-impact expansion
- no discretionary bag holding

### 17.4 Pump.fun Modes
- observe_only
- paper_only
- guarded_live
- disabled

## 18. Token Registry

Build an internal token registry that stores:
- symbol
- chain
- mint or contract address
- decimals
- stablecoin flag
- wrapped/native mapping
- safety status
- allowlisted flag
- disabled flag
- common venues
- pumpFunFlag
- pumpLifecycleState
- denylistReason if blocked

This registry must support:
- ETH <-> WETH normalization
- SOL <-> wrapped SOL handling where needed
- BTC wrappers distinction
- USDC variants by chain
- token aliases and symbol collisions
- Pump.fun mint lifecycle transitions

## 19. Pricing and Profitability Engine

This is the heart of the system.

The engine must compute:

expectedNetUsd =
exitValueUsd
- entryValueUsd
- tradingFeesUsd
- gasUsd
- slippageUsd
- approvalCostUsd
- transferCostUsd
- priorityFeeUsd
- riskBufferUsd

The engine must never treat a raw spread as profit.

### 19.1 Required Cost Inputs
- CEX trading fees
- DEX protocol fees where embedded or explicit
- EVM gas
- Solana network fees
- Solana priority fees if used
- approval gas costs
- estimated slippage
- route price impact
- spread decay buffer
- quote staleness buffer
- Pump.fun-specific liquidity decay buffer
- Pump.fun-specific dump-risk buffer

### 19.2 Profitability Thresholds
Configurable:
- minimum absolute USD profit
- minimum net basis points
- per-asset minimum edge
- per-chain minimum edge
- stricter thresholds during high gas or high volatility
- much stricter thresholds for Pump.fun names

## 20. Liquidity and Safety Filters

Reject any opportunity that violates safety rules.

### 20.1 Global Filters
- net profit below threshold
- quote too stale
- opportunity already executed recently
- insufficient inventory
- insufficient wallet balance
- feature flag disabled
- circuit breaker active

### 20.2 DEX Filters
- price impact too high
- route too many hops
- liquidity below minimum threshold
- token not allowlisted
- gas too high relative to trade size
- slippage too high
- required approval too expensive
- direct venue unavailable
- aggregator confidence too low

### 20.3 Solana Filters
- token not allowlisted
- route too complex
- fee spike
- blockhash too stale
- Jupiter route quality below threshold
- token account setup requirement exceeds value of trade
- low liquidity on pool

### 20.4 Pump.fun Filters
- fresh launch but no validated exit route
- price impact too high
- liquidity too thin
- suspected dead token behavior
- route vanished
- denylisted mint
- holding time limit would likely be exceeded
- social-only momentum with no executable depth
- position size exceeds Pump.fun cap
- token lifecycle unknown

### 20.5 CEX Filters
- order book depth insufficient
- spread too wide
- withdrawal disabled if route depends on asset movement
- venue in degraded state

## 21. Inventory Management

b1dz must track inventory separately by venue and chain.

Examples:
- USD on Coinbase
- USDC on Base hot wallet
- ETH on Base hot wallet
- SOL in Solana hot wallet
- USDC on Solana wallet
- Pump.fun token inventory on Solana wallet
- USDT on Kraken

The bot must not assume capital is freely movable in real time.

Inventory ledger must include:
- available balance
- reserved balance
- pending settlement
- pending tx state
- venue
- chain
- token
- USD reference value

## 22. Trade Modes

### 22.1 Observe Mode
- fetch quotes only
- compute opportunities only
- log everything
- no paper fills
- no live execution

### 22.2 Paper Mode
- simulate fills using modeled slippage and fees
- generate pseudo execution receipts
- compare expected vs simulated realized outcome

### 22.3 Live Mode
- real transactions and orders
- strict max size
- strict allowed assets
- strict chain allowlist
- kill switch enabled

### 22.4 Pump.fun Live Restrictions
- separate feature flag
- separate max size
- separate max concurrent positions
- separate kill switch
- separate daily loss cap

## 23. Backtesting and Replay

Backtesting must support:
- historical CEX top-of-book or candle-derived approximations
- recorded DEX quote snapshots or replay logs
- recorded gas and fee estimates when possible
- modeled slippage
- modeled approval costs
- route rejection logic
- latency assumptions
- Pump.fun event streams or scraped snapshots where available

Where perfect reconstruction is impossible, the system must document the gap clearly.

### 23.1 Minimum Metrics
- gross PnL
- net PnL
- net PnL after all costs
- win rate
- average opportunity size
- fill rate
- failure rate
- execution rejection rate
- PnL by venue
- PnL by chain
- PnL by asset
- PnL by route type
- PnL by token lifecycle state
- Pump.fun exposure versus return

## 24. Logging and Observability

Every decision must be explainable.

Log:
- raw venue quote
- normalized quote
- profitability breakdown
- rejection reasons
- selected opportunity
- execution payload metadata
- tx hash or order id
- confirmation status
- realized outcome
- post-trade variance vs estimate
- Pump.fun lifecycle state changes
- Pump.fun migration detection events

Dashboards should show:
- quote counts by venue
- opportunities by venue pair
- approval costs over time
- gas by chain
- Solana fee trends
- realized vs expected PnL
- error rates
- kill switch events
- Pump.fun watchlist quality
- Pump.fun exits by reason

## 25. Risk Engine

### 25.1 Hard Limits
- max USD size per trade
- max USD size per asset
- max USD size per chain
- max daily loss
- max per-venue loss
- max gas per trade
- max Solana fee per trade
- max slippage bps
- max price impact bps

### 25.2 Pump.fun Hard Limits
- much lower max USD per trade
- max hold time in seconds or minutes
- max concurrent Pump.fun positions
- max daily Pump.fun loss
- max exposure to any single mint
- mandatory stop-loss
- mandatory take-profit or timed exit

### 25.3 Kill Switches
- repeated tx failures
- repeated CEX order failures
- repeated stale quote failures
- chain congestion
- RPC degradation
- abnormal gas spike
- wallet balance too low
- approval stuck state
- realized loss threshold exceeded
- Pump.fun liquidity collapse
- too many Pump.fun stopouts in sequence

## 25A. Node Strategy

The system should support both third-party RPC providers and self-hosted nodes where practical.

Guidance:
- do not require self-hosting for MVP
- track quote freshness and latency by provider
- design the architecture so a self-hosted node can be added later for chains where lower latency or better trace access materially improves results
- prioritize own-node or archive/trace-capable access for serious EVM arbitrage research if third-party RPC quality proves limiting

## 26. RPC and Infrastructure Requirements

### 26.1 EVM
- reliable primary RPC per chain
- fallback RPC support
- configurable timeouts
- health checks
- rate limiting
- metrics per provider

### 26.2 Solana
- reliable primary RPC
- fallback RPC support
- WebSocket support if needed
- health and slot lag checks
- confirmation latency tracking

### 26.3 General
- Dockerized services
- Railway-friendly deployment where possible
- isolated signer service if desired
- environment-based secrets
- detailed structured JSON logs

## 27. Security Requirements

- never expose private keys client-side
- all signing server-side only
- encrypt secrets at rest where possible
- validate token allowlist before trade
- block unknown token mints/contracts by default
- support dry-run mode globally
- support emergency global disable
- store minimal sensitive data in logs
- redact secrets in errors and traces
- require explicit enablement for scrape-based Pump.fun sources

## 28. Recommended MVP Asset Scope

Keep the first live scope narrow.

### 28.1 EVM MVP Assets
- ETH / WETH
- USDC
- USDT
- DAI
- cbBTC or WBTC only if explicitly enabled

### 28.2 Solana MVP Assets
- SOL
- USDC
- USDT
- wrapped BTC or ETH only if explicitly enabled

### 28.3 Pump.fun MVP Scope
- observe and paper mode for broad discovery
- live mode only for explicitly enabled shortlist
- no blind trading of every new launch
- no overnight holds
- no averaging down
- no martingale behavior

### 28.4 Avoid in MVP
- memecoins outside guarded rules
- low-liquidity tokens
- newly deployed tokens without routeable exit
- unverified mints/contracts
- fee-on-transfer tokens

## 29. Recommended Roadmap

### Phase 1: Normalized Quote Infrastructure
Build:
- shared quote types
- adapter interfaces
- token registry
- opportunity model
- profitability engine
- observe mode
- logging

Adapters:
- Coinbase
- Kraken
- Gemini
- Binance.US
- 0x
- 1inch
- Jupiter
- Pump.fun discovery adapter

### Phase 2: Paper Trading
Build:
- paper execution simulator
- slippage model
- gas and fee model
- route replay logs
- comparison dashboards
- Pump.fun lifecycle replay

### Phase 3: Live EVM Execution
Build:
- wallet service
- approval manager
- transaction builder
- receipt tracker
- kill switch controls

### Phase 4: Live Solana Execution
Build:
- Solana wallet service
- Jupiter transaction flow
- confirmation tracking
- priority fee controls
- Solana-specific safety filters

### Phase 5: Guarded Pump.fun Execution
Build:
- Pump.fun rule engine
- allowlist / denylist controls
- forced time-based exit logic
- tighter risk caps
- PumpSwap awareness
- migration-aware execution filters

### Phase 6: Direct Venue Integrations
EVM:
- direct Uniswap
- direct Curve
- direct Balancer

Solana:
- direct Raydium
- direct Orca
- optional Meteora
- direct PumpSwap if justified

### Phase 7: Advanced Strategies
- DEX vs DEX route optimization
- atomic route support where feasible
- direct venue vs aggregator edge testing
- AI-assisted route filtering
- selective cross-chain opportunities

## 30. AI Roadmap

AI is optional and should not control trading in MVP.

Good AI uses later:
- opportunity quality scoring
- regime classification
- anomaly detection
- route failure prediction
- gas spike forecasting
- token risk pattern detection
- post-trade clustering of winners vs losers
- Pump.fun launch quality scoring

Bad AI uses early:
- LLM deciding trades directly
- black-box next-tick prediction
- dynamic parameter changes without guardrails
- buying hype because of social chatter alone

## 31. Suggested Repo Structure

```txt
/apps
  /engine
  /api
  /dashboard
/packages
  /core
  /types
  /config
  /adapters-cex
  /adapters-evm
  /adapters-solana
  /adapters-pumpfun
  /wallet-provider
  /coinpay-wallet-provider
  /profitability
  /risk
  /paper-execution
  /live-execution
  /token-registry
  /observability
```

## 32. Suggested Environment Variables

```env
# General
NODE_ENV=development
LOG_LEVEL=info
MODE=observe

# CEX
COINBASE_API_KEY=
COINBASE_API_SECRET=
KRAKEN_API_KEY=
KRAKEN_API_SECRET=
GEMINI_API_KEY=
GEMINI_API_SECRET=
BINANCE_US_API_KEY=
BINANCE_US_API_SECRET=

# CoinPay / Wallet Provider
COINPAY_CLI_PATH=coinpay
COINPAY_PROFILE=default
WALLET_PROVIDER=coinpay
COINPAY_WEB_WALLET_ENABLED=true

# EVM
EVM_PRIVATE_KEY=
ETHEREUM_RPC_URL=
BASE_RPC_URL=
AVALANCHE_RPC_URL=
ZEROX_API_KEY=
ONEINCH_API_KEY=

# Solana
SOLANA_PRIVATE_KEY=
SOLANA_RPC_URL=
SOLANA_WS_URL=

# Pump.fun
PUMPFUN_MODE=observe_only
PUMPFUN_ENABLE_SCRAPE=false
PUMPFUN_MAX_TRADE_USD=25
PUMPFUN_MAX_HOLD_SECONDS=300
PUMPFUN_MAX_CONCURRENT_POSITIONS=2
PUMPFUN_DAILY_MAX_LOSS_USD=100

# Risk
MAX_TRADE_USD=100
MIN_NET_PROFIT_USD=2
MIN_NET_PROFIT_BPS=15
MAX_GAS_USD=5
MAX_SLIPPAGE_BPS=50
MAX_ROUTE_HOPS=3
```

## 33. MVP Acceptance Criteria

The MVP is complete when:
- `b1dz observe` can stream ranked live opportunities in real time
- the trade daemon can subscribe to those opportunities and apply final execution decisions
- CoinPay CLI can be used as a wallet-provider implementation for supported chains
- b1dz can fetch quotes from all enabled CEX venues
- b1dz can fetch quotes from 0x, 1inch, Jupiter, and Pump.fun discovery sources
- all quotes map into a single normalized format
- the profitability engine computes net expected value after all costs
- unsafe routes are rejected with explicit reasons
- paper trading works for CEX, EVM, Solana, and guarded Pump.fun opportunities
- live EVM execution works for allowed assets on enabled chains
- live Solana execution works via Jupiter for allowed assets
- Pump.fun support works in observe and paper mode by default
- optional guarded Pump.fun live mode enforces tighter risk caps
- inventory tracking works across venues and chains
- dashboards and logs clearly explain why opportunities were accepted or rejected
- kill switch and hard risk limits are enforced

## 34. Success Criteria

This project is successful when:
- b1dz finds more viable opportunities than the current CEX-only engine
- observed edge survives realistic cost modeling
- paper mode closely matches live execution quality
- live mode safely executes small-size profitable routes
- Solana support is first-class, not bolted on later
- Pump.fun support is heavily controlled and does not create recurring bag-holder behavior
- the architecture is clean enough to add direct DEX integrations afterward

## 35. Final Recommendation

Build b1dz as a unified multi-venue arbitrage engine, not as a set of exchange-specific scripts.

Start with:
- CEX quotes
- 0x
- 1inch
- Jupiter
- Pump.fun discovery and guarded lifecycle monitoring
- all-in profitability modeling
- observe mode
- paper mode
- very small live mode

Do not start by becoming an LP.

Do not treat Pump.fun as a free-money machine.

Start by:
- reading onchain liquidity
- routing swaps safely
- modeling the true cost of execution
- comparing routes across CEX, EVM, and Solana venues
- keeping Pump.fun on the shortest leash of all

That is the fastest path to learning whether liquidity-pool support actually improves profitability for b1dz without turning the bot into a bag-holder.
