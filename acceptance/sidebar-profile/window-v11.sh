#!/bin/bash
# Test timing regression only; reuse the unchanged production assets from v9.
set -uo pipefail
umask 077
test "$NODE_OPTIONS" = --max-old-space-size=2048 || exit 2
test "$LP_NUM_THREADS" = 2 || exit 2
test ! -e target/t77/window-v11 || exit 2
git diff --quiet ed14ab3820f72cca662e52916824ba37de14a6d7 HEAD -- core web/src web/package.json web/package-lock.json || exit 2
test "$(cat target/t77/window-v9/head.txt)" = 139411c5d268fb4d80165f80c6f35e53c58a0489 || exit 2
mkdir -p target/t77/window-v11
git rev-parse HEAD > target/t77/window-v11/head.txt
export YUZUNO_UI_DIST="$PWD/target/t77/web-window-v9"
export WEB_TEST_TIMEOUT=180
/bin/bash .github/scripts/web-tests.sh tools/ui.test.mjs 2>&1 | tee target/t77/window-v11/ui.log
exit "${PIPESTATUS[0]}"
