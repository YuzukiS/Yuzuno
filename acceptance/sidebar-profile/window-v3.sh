#!/bin/bash
# First combined data-window candidate. Job cgroup + shared heavy slot.
set -uo pipefail
umask 077
test "$NODE_OPTIONS" = --max-old-space-size=2048 || exit 2
test "$LP_NUM_THREADS" = 2 || exit 2
test ! -e target/t77/web-window-v3 || exit 2
mkdir -p target/t77/window-v3
git diff -- core web > target/t77/window-v3/source.diff
cp core/src/conversation_window.rs target/t77/window-v3/core-window.rs
cp core/tests/conversation_window.rs target/t77/window-v3/core-api-test.rs
cp web/src/ConversationWindow.tsx web/src/conversation-window.css acceptance/sidebar-profile/window-check.mjs target/t77/window-v3/
export TMPDIR="$(mktemp -d /tmp/t77-window-v3.XXXXXX)"
trap 'rmdir "$TMPDIR" 2>/dev/null || true' EXIT
failed=0
(
  cd web || exit
  /usr/bin/node node_modules/typescript/bin/tsc -b &&
  /usr/bin/node node_modules/vite/bin/vite.js build --sourcemap --outDir ../target/t77/web-window-v3
) 2>&1 | tee target/t77/window-v3/build.log
build=${PIPESTATUS[0]}
if [ "$build" -eq 0 ]; then
  export YUZUNO_UI_DIST="$PWD/target/t77/web-window-v3"
  /bin/bash .github/scripts/web-tests.sh tools/ui.test.mjs tools/live-detail.test.mjs tools/output-on-demand-ui.test.mjs tools/auto-read.test.mjs tools/composer-draft.test.mjs 2>&1 | tee target/t77/window-v3/tests.log
  [ "${PIPESTATUS[0]}" -eq 0 ] || failed=1
  export T77_OUT="$PWD/target/t77/window-v3/browser-compatibility"
  /usr/bin/node acceptance/sidebar-profile/window-check.mjs 2>&1 | tee target/t77/window-v3/browser.log
  [ "${PIPESTATUS[0]}" -eq 0 ] || failed=1
else
  failed=1
fi
# Reuse the existing shared Cargo cache under Cargo's own lock. Only one
# rustc runs inside this 2-CPU / 3-GiB / zero-swap Job; no native Core starts.
export CARGO_TARGET_DIR="${HOME}/yuzuno-next/target"
export CARGO_BUILD_JOBS=1
"${HOME}/.cargo/bin/cargo" test --offline --locked -p yuzuno-workspace --lib conversation_window -- --test-threads=1 2>&1 | tee target/t77/window-v3/core-unit.log
core=${PIPESTATUS[0]}
if [ "$core" -eq 0 ]; then
  "${HOME}/.cargo/bin/cargo" test --offline --locked -p yuzuno-workspace --test conversation_window --test output_on_demand -- --test-threads=1 2>&1 | tee target/t77/window-v3/core-api.log
  [ "${PIPESTATUS[0]}" -eq 0 ] || failed=1
else
  failed=1
fi
exit "$failed"
