# PRD — AI Analyzers & Agent Trading ("Coinbase for Agents" analog) — v1

## 0. Inspiration

Coinbase shipped three distinct things bundled in one announcement:

1. **Coinbase Advisor** — an AI investment advisor (AI *gives advice*).
2. **Coinbase for Agents** — external AI systems (Claude, ChatGPT) *connect to
   accounts and trade within defined sub-account limits*.
3. **Base MCP + x402** — the agent-wallet plumbing (MCP tool surface + a
   spend/pay protocol).

This PRD maps all three onto b1dz. The unifying safety primitive is a
**server-side spend budget + ledger** that every AI- or agent-initiated order is
hard-capped against. Authority model (decided): **execute within budget** — AI
and agents may place real orders, but only inside the budget and the existing
risk guards.

## 1. Why this fits b1dz cleanly

b1dz already has the load-bearing infrastructure:

- **OAuth/secret linking** — `packages/core/src/oauth.ts` registry +
  `/api/oauth/[plugin]/start|callback`, AES-256-GCM secret blob in
  `user_settings`, daemon 24/7 token auto-refresh. (See [[project-b1dz-equities-v1]].)
- **Strict per-user secrets** — `getUserSecret`/`getUserPlain` with NO operator
  env fallback, after the multi-tenant leak fix. AI keys MUST use this path.
  (See [[project-b1dz-security-env-fallback]].)
- **A real risk engine** — `@b1dz/equity-engine` `decideEquityOrder()` enforces
  per-trade / position / overnight caps deterministically.
- **Bearer-token API auth** — `apps/web/src/lib/api-auth.ts` already accepts
  `Authorization: Bearer`, so a scoped agent token is an extension, not a rebuild.
- **Per-user runtime config channel into the crypto engine** — the daemon's
  `apps/daemon/src/sources/crypto-trade.ts` reads UI settings from `source_state`
  (`crypto-ui-settings`) and injects them into the engine via runtime setters
  (e.g. `setDailyLossLimitPct`, engine `packages/source-crypto-trade/src/index.ts:1749`).
  The spend budget rides this exact channel — **never env**.
- **AI is already the named v2 path** — `PRD-v1-cex-analysis-engine.md` §2 calls
  out "AI-assisted regime classification" as the intended upgrade.

## 2. Reality check: "OAuth for Anthropic / ChatGPT"

Anthropic and OpenAI are **API-key**, not consumer-OAuth, for programmatic
inference. So "connect your Claude/ChatGPT account" is **paste-an-API-key**,
stored via the same encrypted secret blob the brokers use as their paste
fallback. We add OAuth registry entries only if/where a provider exposes a real
OAuth-for-API flow; otherwise paste is the path.

**Hard rule (two prior incidents):** keys are **BYO per-user**, read via strict
`getUserSecret`. Never a shared operator key — that's both the env-fallback leak
*and* the CrawlProof OpenAI single-point-of-failure. (See
[[project-crawlproof-autoblog-openai-spof]].)

---

## 3. Phase 1 — Crypto spend budget + ledger (FOUNDATION)

The chokepoint everything else enforces against. Small, high-value, ships alone.

### 3.1 Settings (per-user, plain fields — mirror equities)
- `CRYPTO_SPEND_BUDGET_USD` — rolling spend cap (buys) over a window.
- `CRYPTO_BUDGET_WINDOW` — `daily` | `weekly` | `monthly` (default `daily`).
- `CRYPTO_MAX_POSITION_USD` — replaces the hardcoded `$100` (`MAX_POSITION_USD`),
  per-user.
- Keep existing `dailyLossLimitPct` (already per-user via `crypto-ui-settings`).

New settings section `apps/web/src/app/settings/sections/crypto-budget.tsx`
(clone the structure of `sections/equities.tsx`), wired in `settings-client.tsx`.

### 3.2 Engine enforcement (`packages/source-crypto-trade/src/index.ts`)
- Add a `dailySpentUsd` accumulator alongside the existing `dailyFees` /
  `trackedDailyPnl` / `dailyEquityBaselineUsd` daily counters, reset on the same
  day-rollover.
- Add runtime setters `setSpendBudgetUsd(usd, window)` / `setMaxPositionUsd(usd)`
  following the exact `setDailyLossLimitPct` pattern (`index.ts:1749`).
- New guard `budgetWouldExceed(orderUsd)` checked before every BUY, next to the
  daily-loss-limit check (`isDailyLossLimitHit`, `index.ts:1763`). Returns a
  structured reason for logs/UI ("budget: spent $X of $Y this window").
- Record spend on fill (where `recordDailyFee` is called, `index.ts:264`).

### 3.3 Daemon wiring (`apps/daemon/src/sources/crypto-trade.ts`)
- Extend the `crypto-ui-settings` read (~`:119`) to include the new budget
  fields, sourced from the user's strict settings, and call the new runtime
  setters each tick — same place `dailyLossLimitPct` is applied (~`:136`).

### 3.4 Persistence / ledger
- Migration `supabase/migrations/<ts>_crypto_spend_ledger.sql`:
  `crypto_spend_ledger(user_id, ts, source, asset, exchange, usd, agent_token_id
  nullable)` — RLS owner-only (auto-RLS trigger covers new tables).
  - `source` ∈ `engine` | `ai` | `agent` so the same ledger backs Phases 2–3.
- The daemon writes a ledger row per executed buy; the budget window is summed
  from this ledger (survives daemon restarts, unlike an in-memory counter).
- Expose remaining budget in `source_state` so TUI/web/`/api` can show it.

### 3.5 Tests
- Engine unit tests: budget blocks the buy at/over the cap, allows under, resets
  on window rollover, position-cap override. (Pure-function style like the
  `equity-engine` 23-test suite.)

---

## 4. Phase 2 — AI Analyzer (b1dz → Claude/ChatGPT) — "Coinbase Advisor" analog

b1dz calls *out* to the user's own model for regime/setup scoring, overlaid on
the deterministic signal engine. Authority = execute within budget: a strong AI
score can size up within `CRYPTO_SPEND_BUDGET_USD`, never beyond.

### 4.1 Credential linking
- New plain toggle + secret keys via the existing settings/secret pattern:
  `AI_ANALYZER_ENABLED`, `AI_PROVIDER` (`anthropic`|`openai`),
  secret `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` (strict per-user).
- Optionally add `anthropic`/`openai` entries to the OAuth registry *only* if a
  real OAuth-for-API flow exists; otherwise paste-key (the broker fallback path).
- Per the SPOF lesson: if no user key is set, the analyzer is simply **off** for
  that user — no operator-key fallback.

### 4.2 New package `@b1dz/ai-analyzer`
- Pure-ish module: `analyze(snapshot, candles, deterministicSignal) ->
  { regime, confidence, bias, rationale }`. Provider clients are dep-free
  `fetch` calls (matches the broker-client style). **Use the latest Claude model
  per `claude-api` skill — do not hardcode an old model id; verify before
  shipping.**
- Deterministic engine remains the gate; AI output is an *overlay* that can
  raise/lower size within caps and is logged as the "reason" (PRD §2 explainability).
- Strict budget/cost control on the inference side too: cap calls/min, cache by
  snapshot bucket (avoid burning the user's API quota every tick).

### 4.3 Daemon
- New worker (or extend crypto-trade) that, when `AI_ANALYZER_ENABLED`, fetches
  the per-user key (strict), runs `analyze`, and feeds the overlay into the
  sizing path — still bounded by Phase 1.

### 4.4 UI
- "AI Analyzer" settings section: provider, key, enable, max-calls/min.
- Surface the latest AI rationale/regime in dashboard + TUI.

---

## 5. Phase 3 — Agent API + MCP (Claude/ChatGPT → b1dz) — "Coinbase for Agents"

External agents place trades *into* b1dz, hard-capped by a **per-token
sub-account budget** (the "defined sub-account limits").

### 5.1 Scoped agent tokens (the "sub-account")
- Migration `agent_tokens(id, user_id, name, token_hash, scopes[], budget_usd,
  budget_window, spent_usd_cached, allowed_actions, revoked_at, created_at,
  last_used_at)` — RLS owner-only. Store only a hash of the token.
- `scopes`: `read`, `trade:crypto`, `trade:equity`. `allowed_actions` narrows
  (e.g. buy-only, symbol allowlist).
- Each token = an isolated budget that draws from `crypto_spend_ledger` with
  `source='agent'` and `agent_token_id` set, so a runaway agent can only spend
  its own slice.

### 5.2 Token auth
- Extend `api-auth.ts`: a new `authenticateAgent(req)` that accepts
  `Authorization: Bearer b1dz_agent_...`, looks up the hash, checks revocation +
  scope, returns `{ userId, tokenId, scopes, budget }`. Resolves to a
  service-role client scoped to that `user_id` (agent tokens aren't Supabase
  JWTs, so RLS-via-user-JWT doesn't apply — must scope explicitly + fail closed).

### 5.3 Endpoints (thin layer over the existing engine; no new trading logic)
- `POST /api/agent/orders` — place an order; runs through the SAME Phase-1
  budget guard + risk engine, debits the token's budget, writes a ledger row.
- `GET /api/agent/portfolio`, `GET /api/agent/budget`, `GET /api/agent/quote`.
- `POST /api/agent/orders` is **idempotent** (client-supplied key) — agents retry.

### 5.4 MCP server
- New app `apps/mcp` (or a route) exposing the above as MCP tools:
  `get_portfolio`, `get_budget`, `place_order`, `get_quote`. This is the
  Base-MCP analog. x402-style metered pay is a v2 follow-up — v1 = fixed
  per-token budget.
- Token management UI: create/name/revoke agent tokens, set per-token budget,
  view per-token spend. Show the token once on creation (hash stored).

### 5.5 Safety
- Every agent order: scope check → idempotency → risk engine → **Phase-1 budget
  guard (per-token)** → execute → ledger. Fail closed on any check.
- Global kill switch + per-token revoke. Rate-limit per token.
- Audit log of every agent action (the ledger + an `agent_actions` row).

---

## 6. Sequencing & dependencies

1. **Phase 1** (budget + ledger) — required by 2 and 3. Ships standalone.
2. **Phase 2** (AI analyzer) — depends on Phase 1 for "within budget" sizing.
3. **Phase 3** (agent API + MCP) — depends on Phase 1 for per-token budgets;
   reuses the same ledger and engine guard.

## 7. Non-goals (v1)
- No x402 metered micropayments (fixed per-token budget instead).
- No autonomous AI strategy that bypasses the deterministic engine gate.
- No operator-funded shared AI key — strictly BYO per-user.
- No custody change — orders still route to the user's own exchange/broker.

## 8. Open questions
- AI inference cost ceiling per user (calls/min, cache TTL) — defaults TBD.
- Whether agent tokens may also drive equities (`@b1dz/equity-engine`) in v1 or
  crypto-only first.
- MCP transport: hosted SSE endpoint vs. stdio shim the user runs locally.
