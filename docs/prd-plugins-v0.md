# PRD: b1dz Plugins v0

**Status:** Draft — scoped to one day of build
**Owner:** Anthony Ettinger
**Date:** 2026-04-19
**Supersedes (in scope):** the full DEX PRD, which remains the long-form reference

---

## 1. Why this exists

b1dz's in-repo strategies are weak (only `momentumStrategy` ships, and it's labeled as a placeholder). The moat is the execution + risk engine, not the signals. Opening the system to third-party strategies and DEX connectors as **plugins** solves both problems at once and creates a marketplace surface.

A parallel observation: DEX support needs to grow past the single `DexTradeExecutor` that branches on `venue` strings. Each venue wants to be its own unit — which is what a plugin is.

Both problems have the same shape. One plugin model, two plugin kinds.

## 2. Goal for v0

Ship the contracts and one real example of each plugin kind, so the rest of the product can start composing against a stable shape. No marketplace UI, no payments, no sandbox, no runtime loader. Just the seam.

## 3. Non-goals

- Marketplace storefront, ratings, payments, revenue share
- Dynamic plugin loading (WASM / remote modules / sandboxed processes)
- Third-party code with access to keys or wallets
- Solana-beyond-what-already-exists, cross-chain, bridging, LP
- Migrating every existing strategy — `momentumStrategy` is the only one anyway

## 4. Execution model (decided)

**Signals-only for strategy plugins.** Strategy authors emit `Signal` objects via an `evaluate()` function. b1dz owns signing, risk, approvals, execution. Authors never touch keys or wallets. This keeps the trust surface tiny and gives clean PnL attribution per strategy.

**Connectors stay server-side and first-party in v0.** A connector plugin is a typed wrapper around an existing executor — third parties can't ship connectors yet (that's a v2 conversation once we have a sandbox story).

## 5. Scope (one-day build)

### 5.1 Plugin contracts (new code)

New file: `packages/core/src/plugins.ts`

- `PluginManifest` — `{ id, kind, version, name, author?, description?, capabilities[] }`
- `ConnectorPlugin` — venue-scoped: one plugin = one `{ venue, chain }` pair. Method shape mirrors the existing `DexTradeExecutor` but without the internal venue switch.
- `StrategyPlugin` — wraps the existing `Strategy` interface; adds a manifest.
- Marketplace fields (price model, signature hash, etc.) are explicitly **out** of v0 — leave a comment marking where they'll go.

Export from `packages/core/src/index.ts`. No runtime, no registry, no loader — just types.

### 5.2 First real plugins (wrap existing code)

- `packages/source-crypto-trade` exports `momentumStrategyPlugin` — `momentumStrategy` + a manifest. Zero behavior change.
- `apps/daemon/src/executors/dex-trade-executor.ts` gains a thin shim exposing the Uniswap V3 (Base) leg as a `ConnectorPlugin` with `{ venue: 'uniswap-v3', chain: 'base' }`. Jupiter leg gets the same treatment. The multiplexer stays — it becomes the registry analogue until we build a real one.

### 5.3 Documentation (this file plus one more)

- This PRD.
- A `docs/plugins.md` (later, not today) explaining how a third party would author a signals strategy once the runtime exists.

### 5.4 What is explicitly deferred

- Registry object with `register()` / `list()` / `get()`
- Loading plugins from outside the monorepo
- Per-plugin risk config overrides
- Marketplace fields in the manifest
- Approval flow, preview UI, activity log extensions — these belong in the DEX PRD's Phase 1 and can land after the contract shape stabilizes

## 6. Acceptance criteria

- `packages/core` exports `PluginManifest`, `ConnectorPlugin`, `StrategyPlugin` types.
- `momentumStrategy` is also exported as `momentumStrategyPlugin` with a manifest. Consumers that use the existing `Strategy` export continue to compile.
- The Uniswap V3 (Base) and Jupiter legs can be addressed individually as `ConnectorPlugin` values, without the caller needing to know they live inside the aggregate `DexTradeExecutor`.
- No behavior change in the daemon. `DEX_TRADE_EXECUTION=false` stays the default. No on-chain transactions during this work.
- Type check passes. No new runtime dependencies.

## 7. Open questions (answer before v1, not today)

1. How are plugins versioned when the contract itself evolves? (Manifest includes a `protocolVersion` field? Or lean on semver of the package that defines the contract?)
2. What does the revenue attribution record look like — per-signal or per-trade?
3. Who owns the kill switch for a specific plugin vs the global `DEX_TRADE_EXECUTION` flag?
4. Do connector plugins get per-venue risk ceilings (like the current `DEX_TRADE_MAX_USD`) configured in the manifest, in env, or in user settings?
5. When we do add a marketplace, does the signature verification step run at install time, at load time, or both?

## 8. Next session candidates (after v0 lands)

1. Plugin **registry** — `register(plugin)`, `get(id)`, `list(kind)`. Replaces the venue-switch inside `DexTradeExecutor`.
2. **Preview / execute** TUI flow for manual DEX swaps that calls a connector plugin directly, including the Base USDC → SwapRouter02 approval (currently unset).
3. Two hard **risk blocks** in the engine: `MAX_GAS_USD`, `MAX_SLIPPAGE_BPS`.
4. **Activity log** events for `quote_fetched`, `preview_shown`, `tx_submitted`, `tx_confirmed`, `tx_failed`.
5. A **second strategy plugin** that isn't a placeholder — this is where the "strategies suck" problem actually starts getting fixed.
