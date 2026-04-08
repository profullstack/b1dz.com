# b1dz

Multi-source profit monitor. One pipeline, many sources: live auctions
(dealdash, ebay), travel pricing, dropshipping, deals pages, crypto
exchanges. Each source plugs into the same `Source` interface and emits
normalized `Opportunity` records that the dashboard, CLI, and API all read
from a shared store.

## Layout

```
apps/
  web/                Next.js 16 + Tailwind 4 dashboard (PWA-installable)
  cli/                CLI / daemon (will host the lifted ink TUI)
packages/
  core/               Shared types, profit math, storage interface, alert bus, runner
  storage-json/       JSON file storage adapter (Supabase adapter coming)
  source-dealdash/    DealDash source (lift from ~/src/dealdash)
data/                 JSON storage root (gitignored)
```

## Stack

- **pnpm 10** workspaces + **Turbo**
- **Next.js 16** (App Router, RSC), **React 19**, **Tailwind 4**
- **TypeScript** strict, ESM only
- Storage: JSON files now → Supabase later (same `Storage` interface)
- PWA: manifest + minimal service worker in `apps/web/public`

## Setup

```bash
cd ~/src/b1dz.com
pnpm install
pnpm dev:web   # Next.js dashboard
pnpm dev:cli   # daemon
```

## Migration plan (lifting dealdash)

1. Move `~/src/dealdash/dealdash.ts` API helpers into `packages/source-dealdash/src/api.ts`
2. Lift profit math (`profitability`, `getResaleValue`, `nonPackEntryFloor`) into `evaluate()`
3. Lift `bookBid` / `cancelBidBuddy` / `exchangeWinForBids` into `act()`
4. Lift the ink TUI from `dealdash-ink.tsx` into `apps/cli/src/tui/`
5. Wire the runner so the TUI just renders state from the same `Storage`
6. Once the CLI works end-to-end, point `apps/web` at the same data
7. Add `source-ebay` to validate the abstraction
8. Swap `storage-json` for a `storage-supabase` package

The whole project lives at `~/src/b1dz.com`.
