#!/bin/bash
# Reuse already built, hashed assets. Invoked by Jobs under heavy-slot.
set -euo pipefail
umask 077
test "$NODE_OPTIONS" = --max-old-space-size=2048
test "$LP_NUM_THREADS" = 2
mkdir -p "$TMPDIR"
# Chromium derives its Linux worker count from affinity. Limit only this
# acceptance process tree; Jobs still enforces the original CPU/RAM/PID limits.
exec taskset -c 8,9 /usr/bin/node acceptance/interaction-latency/profile.mjs "${1:?measurement label required}" --switch-only
