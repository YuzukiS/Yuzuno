#!/bin/bash
# Structural checkpoint, not final T-77 acceptance or a model-review round.
set -euo pipefail
umask 077
test "$NODE_OPTIONS" = --max-old-space-size=2048
test "$LP_NUM_THREADS" = 2
test ! -e target/t77/web-window-v1
export TMPDIR="$(mktemp -d /tmp/t77-window.XXXXXX)"
trap 'rmdir "$TMPDIR" 2>/dev/null || true' EXIT
mkdir -p target/t77/window-v1
git diff -- web > target/t77/window-v1/source.diff
cp web/src/ConversationWindow.tsx web/src/conversation-window.css acceptance/sidebar-profile/window-check.mjs target/t77/window-v1/
(
  cd web
  /usr/bin/node node_modules/typescript/bin/tsc -b
  /usr/bin/node node_modules/vite/bin/vite.js build --sourcemap --outDir ../target/t77/web-window-v1
) 2>&1 | tee target/t77/window-v1/build.log
export YUZUNO_UI_DIST="$PWD/target/t77/web-window-v1"
export T77_OUT="$PWD/target/t77/window-v1/browser"
/usr/bin/node acceptance/sidebar-profile/window-check.mjs 2>&1 | tee target/t77/window-v1/browser.log
/bin/bash .github/scripts/web-tests.sh tools/ui.test.mjs tools/output-on-demand-ui.test.mjs tools/auto-read.test.mjs tools/composer-draft.test.mjs 2>&1 | tee target/t77/window-v1/tests.log
