#!/usr/bin/env bash
set -euo pipefail

REDIS_PORT="${REDIS_PORT:-6379}"
: "${REDIS_URL:=redis://127.0.0.1:${REDIS_PORT}}"
export REDIS_URL

mkdir -p /tmp/redis
redis-server \
  --bind 127.0.0.1 \
  --port "${REDIS_PORT}" \
  --dir /tmp/redis \
  --save "" \
  --appendonly no \
  --daemonize no &
REDIS_PID=$!

for _ in $(seq 1 150); do
  if redis-cli -u "${REDIS_URL}" ping >/dev/null 2>&1; then
    break
  fi
  sleep 0.2
done

pnpm daemon &
DAEMON_PID=$!

pnpm --filter @b1dz/web start &
WEB_PID=$!

cleanup() {
  kill "$REDIS_PID" "$DAEMON_PID" "$WEB_PID" 2>/dev/null || true
}

trap cleanup EXIT INT TERM

wait -n "$REDIS_PID" "$DAEMON_PID" "$WEB_PID"
STATUS=$?

echo "railway-supervisor: child exited with status $STATUS; stopping service"

cleanup
wait "$REDIS_PID" 2>/dev/null || true
wait "$DAEMON_PID" 2>/dev/null || true
wait "$WEB_PID" 2>/dev/null || true

exit "$STATUS"
