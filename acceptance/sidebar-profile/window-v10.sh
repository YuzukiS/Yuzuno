#!/bin/bash
# R2 original-turn provenance: Core API plus actual clipboard consumption.
set -uo pipefail
umask 077
test "$NODE_OPTIONS" = --max-old-space-size=2048 || exit 2
test "$LP_NUM_THREADS" = 2 || exit 2
test ! -e target/t77/window-v10 || exit 2
# Frontend sources are unchanged; reuse the v9 production build and its tests.
git diff --quiet 139411c5d268fb4d80165f80c6f35e53c58a0489 HEAD -- web/src web/package.json web/package-lock.json || exit 2
test "$(cat target/t77/window-v9/head.txt)" = 139411c5d268fb4d80165f80c6f35e53c58a0489 || exit 2
mkdir -p target/t77/window-v10
git rev-parse HEAD > target/t77/window-v10/head.txt
export TMPDIR="$(mktemp -d /tmp/t77-window-v10.XXXXXX)"
trap 'rmdir "$TMPDIR" 2>/dev/null || true' EXIT
export YUZUNO_UI_DIST="$PWD/target/t77/web-window-v9"
export CARGO_TARGET_DIR="${HOME}/yuzuno-next/target"
export CARGO_BUILD_JOBS=1
failed=0
for filter in mailbox_notice payload; do
  "${HOME}/.cargo/bin/cargo" test --offline --locked -p yuzuno-workspace --lib "$filter" -- --test-threads=1 2>&1 | tee "target/t77/window-v10/core-$filter.log"
  [ "${PIPESTATUS[0]}" -eq 0 ] || failed=1
done
export T77_MAILBOX_OUTPUT="$PWD/target/t77/window-v10/mailbox-fixture.json"
"${HOME}/.cargo/bin/cargo" test --offline --locked -p yuzuno-workspace --test conversation_window -- --test-threads=1 2>&1 | tee target/t77/window-v10/core-api.log
[ "${PIPESTATUS[0]}" -eq 0 ] || exit 1
/bin/bash .github/scripts/web-tests.sh tools/collaboration-ui.test.mjs 2>&1 | tee target/t77/window-v10/collaboration-ui.log
[ "${PIPESTATUS[0]}" -eq 0 ] || failed=1
export T77_OUT="$PWD/target/t77/window-v10/browser-source"
/usr/bin/node acceptance/sidebar-profile/window-source-check.mjs 2>&1 | tee target/t77/window-v10/browser-source.log
[ "${PIPESTATUS[0]}" -eq 0 ] || failed=1
exit "$failed"
