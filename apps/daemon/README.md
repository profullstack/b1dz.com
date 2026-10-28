# @b1dz/daemon

Long-running background daemon. One process per machine, polls every active
user × every registered source on its own cadence. Multi-source from day one
(DealDash, eBay, Amazon, crypto exchanges, …).

## Architecture

```
b1dzd ──┬── DealDash worker ──┬── user A
        │                     ├── user B
        │                     └── user C
        ├── eBay worker      ──┬── user A
        │                     └── user D
        └── crypto-arb       ──┬── user B
                              └── user E
```

`apps/daemon/src/registry.ts` is the source of truth for which sources the
daemon runs. Add a `SourceWorker` there and the scheduler picks it up
without code changes elsewhere.

Every (user, source) pair gets its own `setInterval` timer, so a slow tick
on one user's source can't block another's.

## Run modes

All four start the same binary; the only difference is who supervises it.

### Terminal

```bash
cd ~/src/b1dz.com
pnpm install
pnpm --filter @b1dz/daemon dev
# or globally:
ln -s ~/src/b1dz.com/apps/daemon/bin/b1dzd ~/.local/bin/b1dzd
b1dzd
```

### systemd (Linux server)

```bash
# user-mode unit (no sudo)
mkdir -p ~/.config/systemd/user
sed "s/%i/$USER/g" apps/daemon/systemd/b1dzd.service > ~/.config/systemd/user/b1dzd.service
systemctl --user daemon-reload
systemctl --user enable --now b1dzd
journalctl --user -u b1dzd -f
```

```bash
# system-wide unit (root)
sudo cp apps/daemon/systemd/b1dzd.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now b1dzd
journalctl -u b1dzd -f
```

### Docker

```bash
docker build -t b1dz .
docker run --rm \
  -e NEXT_PUBLIC_SUPABASE_URL=... \
  -e SUPABASE_SECRET_KEY=... \
  b1dz ./apps/daemon/bin/b1dzd
```

### Railway

Deploy the repo as **two services** from the same Dockerfile:

1. `b1dz-web` — leave CMD as default (`pnpm --filter @b1dz/web start`)
2. `b1dz-daemon` — override CMD: `./apps/daemon/bin/b1dzd`

Set `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`,
and `SUPABASE_SECRET_KEY` on both services.

## Sealed user keys and unlock sessions

User secrets (wallet keys, exchange secrets, broker tokens) are sealed under a
key derived from each user's passphrase (`@b1dz/core/sealed-secrets`). The
daemon holds no key that opens them and ignores `SETTINGS_ENCRYPTION_KEY`.

- A user's workers run only while they have an unlocked trading session: the
  web app (`/settings` Vault panel) or CLI (`b1dz unlock --ttl 8h`) sends the
  derived data key to `POST /api/daemon/session`, which forwards it to this
  daemon's loopback control endpoint. The key lives in process memory only
  (TTL default 8h, max 7d, `b1dz lock` / "Lock trading now" to end it).
- Locked users (and legacy server-key rows not yet migrated) pause with
  `daemon.status = "locked"` and a `lockReason` in source_state.
- A restart drops every unlock: users stay paused until they unlock again.
- Operator wallet keys and exchange secrets in env are deleted at startup and
  never used. The operator trades as a normal user who unlocks.

Control endpoint env (same values for web and daemon):
`B1DZ_DAEMON_CONTROL_TOKEN` (required; `scripts/start-railway.sh` generates
one per container boot), `B1DZ_DAEMON_CONTROL_PORT` (default 8790),
`B1DZ_DAEMON_CONTROL_URL` (web side, default `http://127.0.0.1:8790`).

## What it does today

- Discovers users with credentials in `source_state.payload.credentials`
- Schedules a tick per (user, source)
- Re-discovers every 60s to pick up new signups
- Currently the DealDash worker is a **stub** that writes a heartbeat to
  `source_state.payload.daemon` — proves the scheduler is firing per-user
- Phase 3 of `docs/refactor-plan.md` ports the real polling logic from the
  lifted TUI's `tick()` function into `packages/source-dealdash/src/poll.ts`
  and the worker calls it
