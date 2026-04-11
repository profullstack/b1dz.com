#!/bin/bash
set -e

echo "=== b1dz entrypoint ==="
echo "NODE_ENV=$NODE_ENV"
echo "PORT=$PORT"
echo "SUPABASE_SECRET_KEY set: $([ -n "$SUPABASE_SECRET_KEY" ] && echo yes || echo NO)"
echo "KRAKEN_API_KEY set: $([ -n "$KRAKEN_API_KEY" ] && echo yes || echo NO)"

# Test if tsx works
echo "Testing tsx..."
pnpm --filter @b1dz/daemon exec tsx --version 2>&1 || echo "tsx not found!"

# Start daemon
echo "Starting daemon..."
pnpm daemon 2>&1 &
DAEMON_PID=$!

# Give daemon a moment to start (or crash)
sleep 3

# Check if daemon is alive
if kill -0 $DAEMON_PID 2>/dev/null; then
  echo "Daemon running (PID $DAEMON_PID)"
else
  echo "WARNING: Daemon failed to start!"
  wait $DAEMON_PID 2>/dev/null || true
fi

# Start web (foreground)
echo "Starting web on port ${PORT:-8080}..."
exec pnpm start
