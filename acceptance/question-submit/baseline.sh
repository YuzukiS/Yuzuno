#!/bin/bash
set -uo pipefail
umask 077
test "$NODE_OPTIONS" = --max-old-space-size=2048 || exit 2
test "$LP_NUM_THREADS" = 2 || exit 2
test ! -e target/t67/baseline-v1 || exit 2
# Measure current main, including its separately merged update panel changes.
git diff --quiet cda2392ac26458535b4a048d958be9cdf4c9c70d HEAD -- web/src core/src || exit 2
test ! -e target/t67/web-baseline-v1 || exit 2
mkdir -p target/t67/baseline-v1
git rev-parse HEAD > target/t67/baseline-v1/head.txt
(
  cd web || exit
  /usr/bin/node node_modules/typescript/bin/tsc -b &&
  /usr/bin/node node_modules/vite/bin/vite.js build --outDir ../target/t67/web-baseline-v1
) 2>&1 | tee target/t67/baseline-v1/build.log
[ "${PIPESTATUS[0]}" -eq 0 ] || exit 1
export YUZUNO_UI_DIST="$PWD/target/t67/web-baseline-v1"
sha256sum "$YUZUNO_UI_DIST"/index.html "$YUZUNO_UI_DIST"/assets/* > target/t67/baseline-v1/asset-sha256.txt
export T67_OUT="$PWD/target/t67/baseline-v1"
export CARGO_TARGET_DIR="${HOME}/yuzuno-next/target"
export CARGO_BUILD_JOBS=1
export YUZUNO_RESULT_VALIDATOR="$PWD/runtimes/result-validator/validator.mjs"
"${HOME}/.cargo/bin/cargo" test --release --offline --locked -p yuzuno-workspace --test question_submit_profile -- --ignored --nocapture --test-threads=1 2>&1 | tee target/t67/baseline-v1/run.log
exit "${PIPESTATUS[0]}"
