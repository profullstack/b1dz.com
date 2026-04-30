#!/usr/bin/env bash
set -euo pipefail

REDIS_PORT="${REDIS_PORT:-6379}"
: "${REDIS_URL:=redis://127.0.0.1:${REDIS_PORT}}"
export REDIS_URL

DAEMON_RESTART_DELAY="${DAEMON_RESTART_DELAY:-5}"
DAEMON_MAX_DELAY="${DAEMON_MAX_DELAY:-60}"

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

pnpm --filter @b1dz/web start &
WEB_PID=$!

# Daemon supervisor loop — crashes restart with backoff, web stays up.
daemon_supervisor() {
  local delay="$DAEMON_RESTART_DELAY"
  while true; do
    echo "railway-supervisor: starting daemon"
    pnpm daemon &
    DAEMON_PID=$!
    if wait "$DAEMON_PID"; then
      echo "railway-supervisor: daemon exited cleanly — not restarting"
      break
    else
      echo "railway-supervisor: daemon crashed (exit $?) — restarting in ${delay}s"
      sleep "$delay"
      delay=$(( delay * 2 > DAEMON_MAX_DELAY ? DAEMON_MAX_DELAY : delay * 2 ))
    fi
  done
}

daemon_supervisor &
SUPERVISOR_PID=$!

cleanup() {
  echo "railway-supervisor: shutting down"
  kill "$SUPERVISOR_PID" 2>/dev/null || true
  # shellcheck disable=SC2009
  pkill -f "pnpm daemon" 2>/dev/null || true
  kill "$WEB_PID" "$REDIS_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# Only exit the container if Redis or the web server dies.
# A daemon crash is handled by the supervisor loop above.
wait -n "$REDIS_PID" "$WEB_PID"
STATUS=$?
echo "railway-supervisor: Redis or web exited (status $STATUS) — stopping container"
cleanup
wait "$REDIS_PID" 2>/dev/null || true
wait "$WEB_PID" 2>/dev/null || true
exit "$STATUS"
