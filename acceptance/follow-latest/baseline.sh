#!/bin/bash
set -euo pipefail
umask 077
mkdir -p target/t35/baseline
git rev-parse HEAD > target/t35/baseline/head.txt
git diff -- web/src > target/t35/baseline/product.diff
export T35_HEAD="$(git rev-parse HEAD)"
export TMPDIR="$(mktemp -d /tmp/t35-browser.XXXXXX)"
trap 'rmdir "$TMPDIR" 2>/dev/null || true' EXIT
(
  cd web
  /usr/bin/node node_modules/typescript/bin/tsc -b
  /usr/bin/node node_modules/vite/bin/vite.js build --outDir ../target/t35/baseline/web
) 2>&1 | tee target/t35/baseline/build.log
export YUZUNO_UI_DIST="$PWD/target/t35/baseline/web"
export YUZUNO_CHECK_OUTPUT="$PWD/target/t35/baseline/browser"
/usr/bin/node web/tools/follow-latest-check.mjs 2>&1 | tee target/t35/baseline/browser.log
