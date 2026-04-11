#!/bin/sh
set -e

echo "b1dz: starting web API + daemon..."

# Start daemon in background
pnpm daemon &
DAEMON_PID=$!
echo "b1dz: daemon started (PID $DAEMON_PID)"

# Start web API in foreground
echo "b1dz: starting web API on port ${PORT:-3000}..."
pnpm start &
WEB_PID=$!
echo "b1dz: web started (PID $WEB_PID)"

# Wait for either to exit — if one dies, kill the other
wait -n $DAEMON_PID $WEB_PID
EXIT_CODE=$?
echo "b1dz: process exited with code $EXIT_CODE, shutting down..."
kill $DAEMON_PID $WEB_PID 2>/dev/null
wait
exit $EXIT_CODE
