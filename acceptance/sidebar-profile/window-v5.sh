#!/bin/bash
# Fixed candidate: instant latest navigation and observable page anchors; prior v4 evidence retained.
set -uo pipefail
umask 077
test "$NODE_OPTIONS" = --max-old-space-size=2048 || exit 2
test "$LP_NUM_THREADS" = 2 || exit 2
test ! -e target/t77/web-window-v5 || exit 2
mkdir -p target/t77/window-v5
git rev-parse HEAD > target/t77/window-v5/head.txt
git diff 8eac935a5a9a6536e33dbbf3ad43f8b6f013e19b -- core web acceptance/sidebar-profile > target/t77/window-v5/candidate.diff
export TMPDIR="$(mktemp -d /tmp/t77-window-v5.XXXXXX)"
trap 'rmdir "$TMPDIR" 2>/dev/null || true' EXIT
failed=0
(
  cd web || exit
  /usr/bin/node node_modules/typescript/bin/tsc -b &&
  /usr/bin/node node_modules/vite/bin/vite.js build --sourcemap --outDir ../target/t77/web-window-v5
) 2>&1 | tee target/t77/window-v5/build.log
build=${PIPESTATUS[0]}
if [ "$build" -eq 0 ]; then
  export YUZUNO_UI_DIST="$PWD/target/t77/web-window-v5"
  python3 - <<'PY'
import hashlib,json,pathlib
web=pathlib.Path('target/t77/web-window-v5')
pathlib.Path('target/t77/window-v5/assets.json').write_text(json.dumps({str(p.relative_to(web)):hashlib.sha256(p.read_bytes()).hexdigest() for p in web.rglob('*') if p.is_file()},indent=2)+'\n')
PY
  /bin/bash .github/scripts/web-tests.sh tools/ui.test.mjs tools/auto-read.test.mjs 2>&1 | tee target/t77/window-v5/tests.log
  [ "${PIPESTATUS[0]}" -eq 0 ] || failed=1
  export T77_OUT="$PWD/target/t77/window-v5/browser-compatibility"
  /usr/bin/node acceptance/sidebar-profile/window-check.mjs 2>&1 | tee target/t77/window-v5/browser-compatibility.log
  [ "${PIPESTATUS[0]}" -eq 0 ] || failed=1
else
  failed=1
fi
export CARGO_TARGET_DIR="${HOME}/yuzuno-next/target"
export CARGO_BUILD_JOBS=1
"${HOME}/.cargo/bin/cargo" test --offline --locked -p yuzuno-workspace --lib conversation_window -- --test-threads=1 2>&1 | tee target/t77/window-v5/core-unit.log
[ "${PIPESTATUS[0]}" -eq 0 ] || failed=1
"${HOME}/.cargo/bin/cargo" test --offline --locked -p yuzuno-workspace --test conversation_window -- --test-threads=1 2>&1 | tee target/t77/window-v5/core-api.log
core=${PIPESTATUS[0]}
if [ "$core" -eq 0 ]; then
  export T77_FIXTURE="$PWD/target/t77/fixture.json"
  export T77_API_OUTPUT="$PWD/target/t77/window-v5/api-fixture.json"
  "${HOME}/.cargo/bin/cargo" test --offline --locked -p yuzuno-workspace --test conversation_window export_browser_fixture -- --ignored --test-threads=1 2>&1 | tee target/t77/window-v5/core-fixture.log
  fixture=${PIPESTATUS[0]}
  if [ "$fixture" -eq 0 ] && [ "$build" -eq 0 ]; then
    export T77_OUT="$PWD/target/t77/window-v5/browser-api"
    /usr/bin/node acceptance/sidebar-profile/window-api-check.mjs 2>&1 | tee target/t77/window-v5/browser-api.log
    [ "${PIPESTATUS[0]}" -eq 0 ] || failed=1
  else
    failed=1
  fi
else
  failed=1
fi
exit "$failed"
