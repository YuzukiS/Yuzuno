#!/bin/bash
# Submit through the T-68 durable Job and shared heavy-slot wrapper.
set -euo pipefail
umask 077
test "$NODE_OPTIONS" = --max-old-space-size=2048
test "$LP_NUM_THREADS" = 2
test -n "$T68_ASSETS"
test -n "$T68_OUT"
test ! -e "$T68_OUT/report.json"
mkdir -p "$T68_OUT" "$TMPDIR"
taskset -c 8,9 /usr/bin/node acceptance/global-panels/profile.mjs 2>&1 | tee "$T68_OUT/runner.log"
