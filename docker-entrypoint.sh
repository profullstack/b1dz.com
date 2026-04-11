#!/bin/bash
set -e

echo "b1dz: starting web API + daemon..."

# Start daemon in background
pnpm daemon &
DAEMON_PID=$!
echo "b1dz: daemon started (PID $DAEMON_PID)"

# Start web API — standalone server uses PORT env var (Railway sets this)
export PORT=${PORT:-3000}
echo "b1dz: starting web API on port $PORT..."
cd /app/apps/web
node .next/standalone/server.js &
WEB_PID=$!
cd /app
echo "b1dz: web started (PID $WEB_PID)"

# Trap signals for graceful shutdown
trap "echo 'b1dz: shutting down...'; kill $DAEMON_PID $WEB_PID 2>/dev/null; wait; exit 0" SIGTERM SIGINT

# Wait for either to exit
wait -n $DAEMON_PID $WEB_PID 2>/dev/null || true
EXIT_CODE=$?
echo "b1dz: process exited ($EXIT_CODE), stopping..."
kill $DAEMON_PID $WEB_PID 2>/dev/null
wait 2>/dev/null
exit $EXIT_CODE
