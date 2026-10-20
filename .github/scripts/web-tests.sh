#!/usr/bin/env bash
# Run every web/tools/*.test.mjs in an isolated Node process; no retries.
# New files are discovered automatically. Every file runs serially.
# WEB_TEST_TIMEOUT=300 seconds per file; parallel execution is not enabled.
#
# Not run here: web/tools/*-check.mjs and *-browser.mjs. Those Chromium
# acceptance checks require a browser/Core/isolated build and write screenshots.
#
# Usage (from anywhere): .github/scripts/web-tests.sh [file ...]
# Needs npm ci and a checked build first: some tests read web/dist.
# For local runs, set YUZUNO_UI_DIST to an isolated build directory.
# Heap caps alone do not bound RSS; the runner's VM bounds memory.
set -euo pipefail
exec python3 "$(dirname "$0")/web_tests.py" "$@"
