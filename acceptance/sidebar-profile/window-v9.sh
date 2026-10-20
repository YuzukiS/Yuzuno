#!/bin/bash
# R1 source navigation fix: build, relevant UI tests, and bounded browser checks.
set -uo pipefail
umask 077
test "$NODE_OPTIONS" = --max-old-space-size=2048 || exit 2
test "$LP_NUM_THREADS" = 2 || exit 2
test ! -e target/t77/web-window-v9 || exit 2
mkdir -p target/t77/window-v9
git rev-parse HEAD > target/t77/window-v9/head.txt
export TMPDIR="$(mktemp -d /tmp/t77-window-v9.XXXXXX)"
trap 'rmdir "$TMPDIR" 2>/dev/null || true' EXIT
(
  cd web || exit
  /usr/bin/node node_modules/typescript/bin/tsc -b &&
  /usr/bin/node node_modules/vite/bin/vite.js build --sourcemap --outDir ../target/t77/web-window-v9
) 2>&1 | tee target/t77/window-v9/build.log
[ "${PIPESTATUS[0]}" -eq 0 ] || exit 1
export YUZUNO_UI_DIST="$PWD/target/t77/web-window-v9"
failed=0
/bin/bash .github/scripts/web-tests.sh tools/ui.test.mjs tools/live-detail.test.mjs tools/plan-source.test.mjs tools/subagents-ui.test.mjs 2>&1 | tee target/t77/window-v9/tests.log
[ "${PIPESTATUS[0]}" -eq 0 ] || failed=1
export T77_API_OUTPUT="$PWD/target/t77/window-v8/api-fixture.json"
for scenario in source api reading; do
  export T77_OUT="$PWD/target/t77/window-v9/browser-$scenario"
  /usr/bin/node "acceptance/sidebar-profile/window-$scenario-check.mjs" 2>&1 | tee "target/t77/window-v9/browser-$scenario.log"
  [ "${PIPESTATUS[0]}" -eq 0 ] || failed=1
done
exit "$failed"
