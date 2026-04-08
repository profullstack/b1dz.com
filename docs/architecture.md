# b1dz architecture

## Principle

**The b1dz API is the only thing that talks to the outside world.**
Every client (CLI/TUI, browser extension, web app, PWA, native mobile) is
a dumb consumer of `https://b1dz.com/api`. No client ever calls a
third-party API directly. No client stores anything locally that isn't a
pure render cache of API state.

## Layout

```
┌─────────────────────────────────────────────────────────┐
│                  apps/web (b1dz.com)                    │
│                                                         │
│  ┌──────────────┐    ┌──────────────────────────────┐   │
│  │  Next pages  │    │       /api/* routes          │   │
│  │  (RSC + UI)  │    │  ┌──────────┐ ┌────────────┐ │   │
│  │              │    │  │   auth   │ │  storage   │ │   │
│  │              │    │  ├──────────┤ ├────────────┤ │   │
│  │              │    │  │ sources/ │ │  realtime  │ │   │
│  │              │    │  │ dealdash │ │   stream   │ │   │
│  └──────────────┘    │  │ ebay…    │ │            │ │   │
│         │            │  │ crypto…  │ │            │ │   │
│         │            │  └──────────┘ └────────────┘ │   │
│         │            └────────┬─────────────────────┘   │
│         │                     │                         │
│         └──────────┬──────────┘                         │
│                    │                                    │
│                    ▼                                    │
│   ┌────────────────────────────────────────┐           │
│   │  Server-side daemons / pollers         │           │
│   │  (per-user, run inside the app server  │           │
│   │   or as separate Railway services)     │           │
│   └────────────────────────────────────────┘           │
└────────────────────┬────────────────────────────────────┘
                     │
                     ▼
       Supabase (Postgres + Auth + Realtime, RLS enforced)

                     ▲
                     │  HTTPS + Bearer
                     │
   ┌─────────────────┼─────────────────┐
   │                 │                 │
┌──┴───┐ ┌──────┐ ┌──┴────┐ ┌─────────┴─────┐
│ TUI  │ │ Ext  │ │ PWA   │ │  Native Mobile│
│(ink) │ │(chr) │ │(next) │ │(react native) │
└──────┘ └──────┘ └───────┘ └───────────────┘
```

## Data flow

1. **User authenticates** via `/api/auth/login` (or signup). Client stores
   `{ access_token, refresh_token }` in whatever's appropriate (CLI:
   `~/.config/b1dz/credentials.json`; web: cookie; mobile: keychain).
2. **Client subscribes** to either:
   - Polling: `GET /api/storage/source-state/dealdash` every Ns
   - Realtime: `GET /api/stream` (SSE bridging Supabase Realtime)
3. **Server-side daemon** runs the actual work for that user:
   - Polls DealDash with the user's stored cookies
   - Computes opportunities, strategy decisions
   - Writes to `opportunities`, `alerts`, `source_state` tables
   - Posts bids / cancels via DealDash API
4. **Client renders** whatever shows up in the DB.
5. **User actions** (cancel a bid, hit `x` key) → POST to `/api/sources/...`
   → server proxies to DealDash with the user's cookies → updates DB.

The client never sees DealDash. Never sees ValueSERP. Never sees the
captcha solver. Never sees Supabase. Only `b1dz.com/api`.

## Trust boundaries

| Layer | Auth | RLS |
|---|---|---|
| Client → b1dz API | Bearer token (JWT) | n/a |
| b1dz API → Supabase | Publishable key + verified JWT | **enforced** (`auth.uid() = user_id`) |
| b1dz API → DealDash | User's stored session cookies | n/a |
| Background daemon → Supabase | Service role on the same row, scoped to a single user_id | enforced via explicit filtering |

The only secret that lives on the b1dz API server is `SUPABASE_SECRET_KEY`
(used by background daemons that run without a user session). Everything
else is per-user and short-lived.

## Tables

- `opportunities` — scored profit signals from any source
- `alerts` — user-facing events
- `source_state` — per-source persistent state (cookies, caches, P/L history)
- `logs` — append-only event log

All tables have `user_id uuid REFERENCES auth.users` and RLS policies
filtering by `auth.uid()`. Composite PK on `source_state` is
`(user_id, source_id)`.

## Sources

Each source is a `Source<TItem, TOpportunity>` implementation under
`packages/source-*`. Adding a new source (eBay, Amazon, crypto) means:

1. Implement `Source` (poll + evaluate + optional act)
2. Add server-side action routes (`/api/sources/<id>/...`)
3. Add the user's per-source credentials to `source_state.payload.credentials`
4. Add an entry in the source registry so the daemon picks it up

The client SDK exposes a typed wrapper for each source's actions, but
the **client never knows what's behind them** — they're just authenticated
b1dz endpoints.
