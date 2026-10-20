#!/bin/bash
# Run under a Yuzuno Job and the shared heavy-slot wrapper. All browser data,
# HTTP fixtures and build outputs are isolated from the daily Core/UI.
set -uo pipefail
out="${T71_CHECK_OUT:-$PWD/target/t71-followup/check}"
mkdir -p "$out"
failed=0
check() {
  local label="$1"
  shift
  "$@" > "$out/$label.log" 2>&1
  local rc=$?
  echo "$label=$rc"
  if [ "$rc" -ne 0 ]; then tail -60 "$out/$label.log"; failed=1; fi
}
git rev-parse HEAD > "$out/head.txt"
check core cargo test --locked -j 2 -p yuzuno-workspace --lib ci_monitor:: -- --test-threads=1
check skills python3 scripts/check_agent_skills.py
cd web || exit 2
check typecheck ./node_modules/.bin/tsc --noEmit
check ui node tools/ci-refresh-strict.test.mjs
check jobs node tools/jobs-ui.test.mjs
check statusbar node tools/statusbar-background.test.mjs
check build ./node_modules/.bin/vite build --outDir "$out/dist" --emptyOutDir
check browser env CI_BROWSER_OUT="$out/browser" node tools/ci-stopped-browser.mjs
check ci-browser env CI_BROWSER_OUT="$out/ci-browser" node tools/ci-browser.mjs
exit "$failed"
