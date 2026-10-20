#!/bin/bash
set -euo pipefail
umask 077
mkdir -p target/t35/diagnostic
# Reuse the retained product build from the completed baseline Job; only the
# driver has changed. Record asset hashes alongside the exact product base.
find target/t35/baseline/web -type f -print0 | sort -z | xargs -0 sha256sum > target/t35/diagnostic/assets.sha256
git rev-parse HEAD > target/t35/diagnostic/driver-head.txt
export T35_HEAD=6673c3ef237a934fd5220cb6ce15738ec78d79bf
export T35_SHAPES=short,paged-delay
export T35_MOTIONS=no-preference
export T35_TRACE=1
export YUZUNO_UI_DIST="$PWD/target/t35/baseline/web"
export YUZUNO_CHECK_OUTPUT="$PWD/target/t35/diagnostic/browser"
export TMPDIR="$(mktemp -d /tmp/t35-trace.XXXXXX)"
trap 'rmdir "$TMPDIR" 2>/dev/null || true' EXIT
/usr/bin/node web/tools/follow-latest-check.mjs 2>&1 | tee target/t35/diagnostic/browser.log
