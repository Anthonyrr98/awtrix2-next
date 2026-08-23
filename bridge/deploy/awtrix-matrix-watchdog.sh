#!/bin/sh
set -eu

STATE_FILE=/run/awtrix-matrix-watchdog-misses
CONNECTIONS=$(ss -Htn state established '( sport = :7001 )' | wc -l)

if [ "$CONNECTIONS" -ge 2 ]; then
    echo 0 > "$STATE_FILE"
    exit 0
fi

MISSES=0
if [ -r "$STATE_FILE" ]; then
    MISSES=$(cat "$STATE_FILE" 2>/dev/null || echo 0)
fi
MISSES=$((MISSES + 1))
echo "$MISSES" > "$STATE_FILE"

# Timer runs every 30 seconds. Two misses avoid restarting for a brief Wi-Fi wobble.
if [ "$MISSES" -lt 2 ]; then
    exit 0
fi

curl -fsS -X POST http://127.0.0.1:7100/api/gif/stop \
    -H 'Content-Type: application/json' -d '{}' >/dev/null 2>&1 || true
systemctl restart awtrix2
echo 0 > "$STATE_FILE"
logger -t awtrix-watchdog "Matrix connection missing; stopped GIF and restarted awtrix2"
