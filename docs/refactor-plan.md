# Refactor plan: lift everything onto the API

Status legend:  ✅ done  ·  🚧 in progress  ·  ⏭ next  ·  📋 planned

## Phase 1 — auth & storage on the API (DONE)

- ✅ `/api/auth/{signup,login,refresh}`, `/api/me`
- ✅ `/api/storage/:collection/:key` (GET / PUT / DELETE)
- ✅ `/api/storage/:collection` (LIST)
- ✅ `@b1dz/storage-b1dz-api` adapter — replaces direct Supabase access
- ✅ Multi-tenant RLS migration applied
- ✅ CLI signup/login flows hit the API

## Phase 2 — DealDash actions on the API (DONE for v0)

- ✅ `/api/sources/dealdash/book-bid/:auctionId`
- ✅ `/api/sources/dealdash/cancel-bid/:auctionId`
- ✅ `/api/sources/dealdash/exchange/:auctionId`
- ✅ `/api/sources/dealdash/page-info/:auctionId`
- ✅ `/api/sources/dealdash/market-price?title=…`
- ✅ Server-side cookie loader (`apps/web/src/lib/dealdash-server.ts`)
- ✅ `@b1dz/sdk` package — typed wrappers all clients import
- ⏭ `/api/sources/dealdash/connect` (paste cookies)
- ⏭ `/api/sources/dealdash/login` (automated headless login + capsolver — currently in CLI, move to API)

## Phase 3 — DealDash polling on the API ⏭ NEXT BIG ITEM

The TUI's `tick()` function in `apps/cli/src/tui/dealdash.tsx` is ~600
lines that wraps the entire DealDash polling + strategy. It needs to be
extracted into a server-side per-user worker.

- ⏭ Lift `tick()` into `packages/source-dealdash/src/poll.ts`
  - Refactor `apps/cli/src/dealdash/api.ts` to take state as a parameter
    instead of using module globals (so multiple users can share the
    same code path on the same Node process)
  - All DealDash HTTP calls go through a request-scoped fetcher with
    that user's cookies
- ⏭ `/api/sources/dealdash/poll` — runs one tick for the authenticated
  user, writes results to source_state + opportunities + alerts
- ⏭ Per-user background loop on the API server:
  - Option A: long-running worker process that iterates active users
  - Option B: Vercel/Railway cron hitting `/api/sources/dealdash/poll-all`
- ⏭ Strip all DealDash + ValueSERP fetches from `apps/cli/src/tui/dealdash.tsx`
  — TUI becomes a thin React renderer that subscribes to the DB and
  fires user actions through the SDK

## Phase 4 — Realtime stream

- 📋 `/api/stream` — SSE that bridges Supabase Realtime
- 📋 Clients subscribe instead of polling source_state
- 📋 Push notifications (web push, native APNs/FCM) plumbed through the
  same channel

## Phase 5 — Other sources

Each new source repeats the dealdash pattern:

- 📋 `packages/source-ebay`, `source-amazon`, `source-binance-us`, `source-kraken`
- 📋 Per-source action routes under `/api/sources/<id>/`
- 📋 Per-source credentials in `source_state.payload.credentials`
- 📋 SDK wrappers under `B1dzClient.{ebay,amazon,…}`

## Phase 6 — Native mobile + extension

- 📋 React Native app under `apps/mobile`, ships the SDK
- 📋 Browser extension (`apps/extension` already stubbed) finished —
  syncs DealDash cookies via the SDK on a button press
- 📋 PWA install prompts on the web app

## Phase 7 — Billing + tenancy

- 📋 Stripe metering on captcha solves, ValueSERP credits, etc.
- 📋 Per-user usage caps in API routes
- 📋 Admin dashboard for impersonation / debugging

## Out-of-scope until later

- Multi-region deploy
- Anything other than DealDash as a working source
- Complex strategies beyond the existing one
