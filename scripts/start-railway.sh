#!/usr/bin/env bash
set -euo pipefail

pnpm daemon &
DAEMON_PID=$!

pnpm --filter @b1dz/web start &
WEB_PID=$!

cleanup() {
  kill "$DAEMON_PID" "$WEB_PID" 2>/dev/null || true
}

trap cleanup EXIT INT TERM

wait -n "$DAEMON_PID" "$WEB_PID"
STATUS=$?

echo "railway-supervisor: child exited with status $STATUS; stopping service"

cleanup
wait "$DAEMON_PID" 2>/dev/null || true
wait "$WEB_PID" 2>/dev/null || true

exit "$STATUS"
