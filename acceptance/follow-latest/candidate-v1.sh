#!/bin/bash
set -euo pipefail
umask 077
mkdir -p target/t35/candidate-v1
git rev-parse HEAD > target/t35/candidate-v1/head.txt
git diff 6673c3ef237a934fd5220cb6ce15738ec78d79bf -- web/src > target/t35/candidate-v1/product.diff
export T35_HEAD="$(git rev-parse HEAD)"
export TMPDIR="$(mktemp -d /tmp/t35-candidate.XXXXXX)"
trap 'rmdir "$TMPDIR" 2>/dev/null || true' EXIT
(
  cd web
  /usr/bin/node node_modules/typescript/bin/tsc -b
  /usr/bin/node node_modules/vite/bin/vite.js build --sourcemap --outDir ../target/t35/candidate-v1/web
) 2>&1 | tee target/t35/candidate-v1/build.log
export YUZUNO_UI_DIST="$PWD/target/t35/candidate-v1/web"
export YUZUNO_CHECK_OUTPUT="$PWD/target/t35/candidate-v1/browser"
export T35_TRACE=1
failed=0
/usr/bin/node web/tools/follow-latest-check.mjs 2>&1 | tee target/t35/candidate-v1/browser.log || failed=1
/bin/bash .github/scripts/web-tests.sh tools/ui.test.mjs tools/live-detail.test.mjs 2>&1 | tee target/t35/candidate-v1/tests.log || failed=1
exit "$failed"
