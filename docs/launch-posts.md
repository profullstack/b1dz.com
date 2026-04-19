# b1dz Plugin Store — launch post drafts

Drafts for the six platforms already referenced on the b1dz homepage. Review, edit voice, and post manually — Claude can't hit external accounts without credentials.

Store URL to link: `https://b1dz.com/store`
PRD for anyone asking for depth: `https://github.com/profullstack/b1dz.com/blob/master/docs/prd-plugins-v0.md`

---

## X / Twitter (280 chars)

> Opening the b1dz terminal to third-party strategies.
>
> Signals-only: authors publish signal streams, our engine signs the trades. No plugin ever touches your keys.
>
> First catalog is live → b1dz.com/store
>
> Authoring SDK soon. Sell your edge without running your own infra.

_Char count: ~270. Swap hashtags in if you want (#crypto #algotrading) — I'd leave them off for tone._

---

## Bluesky (300 chars)

> b1dz is becoming a plugin platform.
>
> Signals-only execution — strategy authors publish `{ side, strength, reason }` streams and our engine owns signing, risk, approvals. Authors never touch user keys.
>
> Catalog: b1dz.com/store
> Architecture: the PRD is in the repo.

_Char count: ~280._

---

## Reddit (r/algotrading — consider also r/CryptoCurrency, r/SoloDev)

**Title:** We opened our crypto trading terminal to third-party strategies — signals-only, so authors never touch your keys

**Body:**

We ship an AI arbitrage terminal called b1dz (multi-CEX + DEX on Base and Solana). We've been honest with ourselves: the strategies we ship in-repo are weak — we have one placeholder momentum rule. The actual moat is our execution + risk engine, not the signals.

So we're opening it up. Third parties can author strategies that run on our infrastructure, and users can install them from a catalog.

The architectural call we made: **signals-only**. Strategy authors emit normalized `Signal` objects (`{ side, strength, reason }`) from an `evaluate()` function. Our engine applies each user's risk limits, signs trades, and tracks realized-vs-expected PnL. Authors never see a wallet. No sandbox escape risk, clean revenue attribution per signal.

Full-code strategies (WASM / containers) are explicitly not on the v1 roadmap. We'd rather ship a tight, verifiable contract than a sandbox we have to defend forever.

v0 is a read-only catalog. Authoring SDK opens next. Payout models: monthly subscription or PnL rev-share — authors pick.

Store: https://b1dz.com/store
PRD (full architecture): https://github.com/profullstack/b1dz.com/blob/master/docs/prd-plugins-v0.md

Happy to answer questions about the execution model, attribution math, or why we didn't go the WASM route.

---

## Stacker News

**Title:** b1dz plugin store — signals-only, authors never touch your keys

**Body:**

Opened our crypto trading terminal to third-party strategies. Signals-only: authors emit `{ side, strength, reason }` streams, our engine signs the trades. Plugin code never sees a wallet. Non-custodial the whole way through.

Catalog: https://b1dz.com/store

Architecture PRD in the repo. Rev-share or subscription payout — author's choice.

---

## Hacker News

**Title:** Show HN: b1dz — a signals-only plugin store for a crypto trading terminal

**URL:** https://b1dz.com/store

**First comment (HN culture — post as top-level reply to your own submission):**

Hey HN — I'm building b1dz, a terminal for multi-exchange crypto trading. We've been shipping first-party strategies and they've been weak — only one placeholder rule is in production.

Rather than hire a quant team, we're opening the terminal to third-party strategies. The architectural question I want feedback on: we chose **signals-only** over sandboxed code.

- Signals-only: authors publish a stream of `{ side, strength, reason }` objects from an `evaluate()` function. b1dz applies user risk limits, signs trades, tracks realized-vs-expected PnL. Authors never touch keys. Trust surface = the signal shape. Revenue attribution is per-signal.
- The alternative we rejected: WASM / containerized strategies with scoped APIs. More expressive but you own a sandbox escape surface forever.

PRD: https://github.com/profullstack/b1dz.com/blob/master/docs/prd-plugins-v0.md
Plugin contracts (~70 lines of TS): https://github.com/profullstack/b1dz.com/blob/master/packages/core/src/plugins.ts

Honest question: is there a category of strategy signals-only can't express that would justify the sandbox complexity later? Arbitrage patterns where the author needs to observe tx-level state? Would love to hear from anyone who has shipped something like this.

---

## dev.to (long-form technical)

**Title:** Why our crypto trading plugin store is signals-only, not WASM

**Tags:** `architecture`, `typescript`, `crypto`, `plugins`

**Body:**

We ship b1dz, a crypto trading terminal across several CEXes (Kraken, Coinbase, Binance.US, Gemini) and DEXes (Uniswap V3 on Base, Jupiter on Solana). The strategies that shipped in-repo were weak — honestly, one placeholder momentum rule. The moat was the execution and risk engine, not the signals on top of it.

So we're opening it up. Third-party strategies. A plugin store at `/store`. Authoring SDK next.

There was exactly one architectural decision that mattered. It's the one that shapes every downstream question about sandboxing, revenue attribution, trust, and how we handle malicious authors.

## The choice: signals-only vs sandboxed code

Two options for third-party strategies:

**Option A — sandboxed code.** Authors ship WASM modules (or containers, or quickjs, or whatever isolates) with a scoped API for market data access. The sandbox decides what they can and can't do. They might be allowed to call `placeOrder()` through a capability-restricted interface.

**Option B — signals-only.** Authors emit normalized `Signal` objects from a pure `evaluate()` function. The platform owns signing, risk, approvals, execution. Authors never see a wallet, never touch a key, never call an order endpoint.

We picked B. Here's the contract, which you can read in full in [`packages/core/src/plugins.ts`](https://github.com/profullstack/b1dz.com/blob/master/packages/core/src/plugins.ts):

```ts
export interface Signal {
  side: 'buy' | 'sell';
  strength: number;        // 0..1
  reason: string;
}

export interface StrategyPlugin {
  manifest: PluginManifest & { kind: 'strategy' };
  evaluate(snap: MarketSnapshot, history: MarketSnapshot[]): Signal | null;
}
```

That's the entire surface for a strategy plugin. No I/O, no network, no wallet access. Given a market snapshot and some history, return a signal or null.

## Why signals-only wins for a trading platform

**1. The trust surface is finite.** With signals-only, the worst thing a malicious author can do is emit bad signals. User risk limits (max slippage, max notional, daily loss caps, kill switch) apply before the engine signs anything. With a WASM sandbox, we'd be on the hook forever for every escape bug, every side-channel, every proxy'd API call they figure out how to smuggle through.

**2. Revenue attribution is trivial.** We already store expected-vs-realized PnL per trade. Tagging each trade with the signal that produced it gives us per-author performance attribution without any new plumbing. In the WASM world, who "owns" a trade when the author's code composed three data sources and called our order API? Much messier.

**3. It's verifiable by the author's users.** A signals-only strategy can be reproduced offline against historical snapshots. Users can independently verify an author's claimed edge without needing to trust our runtime. Sandboxed code is a black box by construction.

**4. Pricing models fall out naturally.** Subscription: pay monthly to subscribe to an author's signal stream. Rev-share: author takes X bps of realized PnL attributable to their signals. Both are clean because the unit of account (the signal) is well-defined.

## What signals-only gives up

Strategies that need to observe transaction-level state, MEV-sensitive execution patterns, flash-loan-style atomic composition — these don't fit. For us that's fine: those belong in first-party connector code, not third-party strategy code. The execution engine is ours. Authors produce intent; we produce outcome.

If we ever need more expressiveness, we'll probably add a second plugin kind — "execution-policy plugin," still sandboxed-by-contract, not sandboxed-by-runtime — before we reach for WASM.

## What shipped this week

- [`PluginManifest` / `ConnectorPlugin` / `StrategyPlugin`](https://github.com/profullstack/b1dz.com/blob/master/packages/core/src/plugins.ts) — 70 lines of TypeScript, the whole contract.
- A [read-only catalog page](https://b1dz.com/store) rendering the three first-party plugins.
- [`docs/prd-plugins-v0.md`](https://github.com/profullstack/b1dz.com/blob/master/docs/prd-plugins-v0.md) — one-day scope, explicit non-goals.

The authoring SDK and the registry runtime land next. If you're building anything similar — particularly a third-party plugin story for a financial product — I'd love to hear how you're thinking about the trust surface.

---

## Notes before posting

- **Timing:** HN posts late US morning do best (~9-11am PT). Reddit peaks mid-afternoon PT on r/algotrading. X/Bluesky anytime.
- **Order suggestion:** dev.to first (permalink to reference), then HN with dev.to link in the comment, then Reddit, then short-form (X, Bluesky, Stacker News).
- **Don't cross-link immediately.** Posting the same URL across six platforms within ten minutes can get auto-flagged. Space by 15-30 min.
- **Comment readiness:** expect "what's stopping an author from colluding to pump a low-liquidity pair and cash out?" — have an answer ready. (Real one: per-pair notional caps + liquidity gates + the fact that authors don't control execution timing.)
