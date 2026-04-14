# TODO

Tracks work from PRD v2 (DEX + Solana + Pump.fun). Current v1 CEX strategy
work remains in the codebase and stays live-disabled while we build out the
multi-venue architecture.

## Phase 1 — Normalized Quote Infrastructure (foundation for everything)

- [ ] Define `NormalizedQuote` and `Opportunity` types in a new `packages/types` module per PRD §13
- [ ] Venue adapter interface in `packages/core` per PRD §14
- [ ] Token registry (`packages/token-registry`) per PRD §18 with ETH/WETH + SOL wrap normalization
- [ ] Profitability engine (`packages/profitability`) computing `expectedNetUsd` per PRD §19
- [ ] Wallet-provider abstraction (`packages/wallet-provider`) per PRD §15A
- [ ] `b1dz observe` CLI / runtime — streams ranked opportunities, never executes (PRD §11A.1)
- [ ] Trade daemon subscribes to observe events, applies final checks, decides execute/paper/reject (PRD §11A.2)
- [ ] Event channel between observe and daemon (Redis streams / NATS / Postgres queue — pick one)

## CEX adapters (wrap existing code into the new interface)

- [ ] Wrap existing Kraken price/trade logic as CEX adapter
- [ ] Wrap existing Coinbase logic as CEX adapter
- [ ] Wrap existing Binance.US logic as CEX adapter
- [ ] **Gemini** — trading credentials (price feed already wired observe-only)
- [ ] **Bitstamp** — price feed + trading credentials
  - Public OHLC: `https://www.bitstamp.net/api/v2/ohlc/{pair}/`
  - Taker fee: 0.40% (reduces with volume). US-legal.
- [ ] **Bitfinex** — price feed + trading credentials
  - Public OHLC: `https://api-pub.bitfinex.com/v2/candles/trade:{tf}:{pair}/hist`
  - Taker fee: 0.20% (0.10% at higher tiers). Not available to US retail — flag legal review.

## EVM DEX / Aggregator adapters (PRD §6.2, §14.2, §15)

- [ ] 0x adapter (quote + calldata + tx submission)
- [ ] 1inch adapter (quote + tx submission)
- [ ] Direct Uniswap integration for contract-level validation (PRD §14.5 ABI workflow)
- [ ] EVM pool graph + 2/3-hop route enumeration (PRD §12A)
- [ ] Approval manager with exact/safe policy (PRD §15.2)
- [ ] EIP-1559 gas strategy + stale-quote rejection (PRD §15.3)
- [ ] Tx simulation before submit (PRD §15.4)
- [ ] RPC config registry with fallback support per chain (PRD §26.1)
- [ ] Chain allowlist in MVP: Base + Avalanche + Ethereum (reference only)

## Solana adapters (PRD §6.3, §14.3, §16)

- [ ] Jupiter aggregator adapter (quote + prepared transaction)
- [ ] Solana wallet service (SPL token account awareness, SOL balance monitoring)
- [ ] Priority fee + blockhash freshness handling
- [ ] Solana safety filters (mint allowlist, freeze-authority check, liquidity threshold)

## Pump.fun (PRD §6.4, §14.4, §17)

- [ ] Pump.fun discovery adapter (new launches, bonding-curve state)
- [ ] Lifecycle classifier (`new_launch` / `bonding_curve` / `migrating` / `pumpswap` / `external_pool`)
- [ ] Pump.fun rule engine + mode flag (`observe_only` / `paper_only` / `guarded_live` / `disabled`)
- [ ] Entry filters (liquidity, spread, route-out existence, denylist)
- [ ] Exit rules (hard TP, hard SL, time exit, liquidity-collapse detection)
- [ ] Scrape fallback behind `PUMPFUN_ENABLE_SCRAPE` feature flag

## CoinPay wallet provider (PRD §11B, §15A)

- [ ] `packages/coinpay-wallet-provider` — implements wallet-provider interface over CoinPay CLI
- [ ] Fallback direct signers for EVM and Solana where CoinPay doesn't cover

## Inventory ledger (PRD §21)

- [ ] Per-(venue, chain, token) balance tracking with available / reserved / pending states
- [ ] USD reference value alongside native balances
- [ ] Integration with all adapter balance endpoints

## Risk engine (PRD §25)

- [ ] Hard trade/asset/chain/daily-loss limits
- [ ] Pump.fun-specific limits (tighter caps, mandatory stops, max hold time)
- [ ] Kill switches on repeated failures, gas spikes, balance too low, etc.

## Paper trading + Backtesting (PRD §22, §23)

- [ ] Paper execution simulator with modeled slippage + fees + gas
- [ ] Route replay logs
- [ ] Persist quote snapshots for later replay
- [ ] Metrics: gross/net PnL, win rate, by-venue/chain/asset/route-type breakdowns

## Observability (PRD §24)

- [ ] Structured decision log (raw quote → normalized → profitability breakdown → reject reasons)
- [ ] Dashboards (quote counts per venue, opportunities by venue-pair, realized vs expected PnL)
- [ ] Latency and health metrics per RPC / API

## Security (PRD §27)

- [ ] All signing server-side
- [ ] Token allowlist enforced before any trade
- [ ] Secret redaction in error paths
- [ ] Emergency global disable switch

## v1 remnants

- [ ] Keep v1 composite strategy and `b1dz backtest` alive but live-disabled via `[d]` toggle
- [ ] Existing TUI + daemon + supabase migrations stay as-is while v2 is built alongside
- [ ] Original PRD archived at `PRD-v1-cex-analysis-engine.md`
