#!/bin/bash
# Reuse verified fixed assets; a short TMPDIR fits Chromium's Unix socket path.
# Run through a bounded durable Job and the shared heavy-slot wrapper.
set -euo pipefail
umask 077
test "$NODE_OPTIONS" = --max-old-space-size=2048
test "$LP_NUM_THREADS" = 2
test "$(git rev-parse HEAD)" = 8eac935a5a9a6536e33dbbf3ad43f8b6f013e19b
git diff --exit-code -- web
test -n "$T77_ASSETS"
test -n "$T77_OUT"
test ! -e "$T77_OUT/report.json"
export TMPDIR="$(mktemp -d /tmp/t77-profile.XXXXXX)"
trap 'rmdir "$TMPDIR" 2>/dev/null || true' EXIT
mkdir -p "$T77_OUT"
taskset -c 8,9 /usr/bin/node acceptance/sidebar-profile/profile.mjs 2>&1 | tee "$T77_OUT/runner.log"
