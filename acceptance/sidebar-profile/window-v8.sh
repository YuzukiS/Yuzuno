#!/bin/bash
# Final collections and metadata corrections; paired performance evidence with fixed builds.
set -uo pipefail
umask 077
test "$NODE_OPTIONS" = --max-old-space-size=2048 || exit 2
test "$LP_NUM_THREADS" = 2 || exit 2
test ! -e target/t77/web-window-v8 || exit 2
mkdir -p target/t77/window-v8
git rev-parse HEAD > target/t77/window-v8/head.txt
git diff 8eac935a5a9a6536e33dbbf3ad43f8b6f013e19b -- core web acceptance/sidebar-profile > target/t77/window-v8/candidate.diff
export TMPDIR="$(mktemp -d /tmp/t77-window-v8.XXXXXX)"
trap 'rmdir "$TMPDIR" 2>/dev/null || true' EXIT
(
  cd web || exit
  /usr/bin/node node_modules/typescript/bin/tsc -b &&
  /usr/bin/node node_modules/vite/bin/vite.js build --sourcemap --outDir ../target/t77/web-window-v8
) 2>&1 | tee target/t77/window-v8/build.log
[ "${PIPESTATUS[0]}" -eq 0 ] || exit 1
export YUZUNO_UI_DIST="$PWD/target/t77/web-window-v8"
python3 - <<'ASSETS'
import hashlib,json,pathlib
web=pathlib.Path('target/t77/web-window-v8')
pathlib.Path('target/t77/window-v8/assets.json').write_text(json.dumps({str(p.relative_to(web)):hashlib.sha256(p.read_bytes()).hexdigest() for p in web.rglob('*') if p.is_file()},indent=2)+'\n')
ASSETS
failed=0
/bin/bash .github/scripts/web-tests.sh tools/ui.test.mjs tools/live-detail.test.mjs tools/plan-source.test.mjs tools/subagents-ui.test.mjs 2>&1 | tee target/t77/window-v8/tests.log
[ "${PIPESTATUS[0]}" -eq 0 ] || failed=1
export CARGO_TARGET_DIR="${HOME}/yuzuno-next/target"
export CARGO_BUILD_JOBS=1
"${HOME}/.cargo/bin/cargo" test --offline --locked -p yuzuno-workspace --lib conversation_window -- --test-threads=1 2>&1 | tee target/t77/window-v8/core-unit.log
[ "${PIPESTATUS[0]}" -eq 0 ] || failed=1
"${HOME}/.cargo/bin/cargo" test --offline --locked -p yuzuno-workspace --test conversation_window -- --test-threads=1 2>&1 | tee target/t77/window-v8/core-api.log
[ "${PIPESTATUS[0]}" -eq 0 ] || failed=1
export T77_FIXTURE="$PWD/target/t77/fixture.json"
export T77_API_OUTPUT="$PWD/target/t77/window-v8/api-fixture.json"
"${HOME}/.cargo/bin/cargo" test --offline --locked -p yuzuno-workspace --test conversation_window export_browser_fixture -- --ignored --test-threads=1 2>&1 | tee target/t77/window-v8/core-fixture.log
[ "${PIPESTATUS[0]}" -eq 0 ] || exit 1
export T77_API_SHA="$(sha256sum "$T77_API_OUTPUT" | cut -d ' ' -f 1)"
for scenario in compatibility api reading collections; do
  script=window-check.mjs
  [ "$scenario" = api ] && script=window-api-check.mjs
  [ "$scenario" = reading ] && script=window-reading-check.mjs
  [ "$scenario" = collections ] && script=window-collections-check.mjs
  export T77_OUT="$PWD/target/t77/window-v8/browser-$scenario"
  /usr/bin/node "acceptance/sidebar-profile/$script" 2>&1 | tee "target/t77/window-v8/browser-$scenario.log"
  [ "${PIPESTATUS[0]}" -eq 0 ] || failed=1
done
python3 - <<'MANIFEST'
import json,pathlib,subprocess
base=json.loads(pathlib.Path('target/t77/baseline-assets.json').read_text())
base['sourceCommit']=subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip()
base['web']=str(pathlib.Path('target/t77/web-window-v8').resolve())
base['sha256']=json.loads(pathlib.Path('target/t77/window-v8/assets.json').read_text())
pathlib.Path('target/t77/window-v8/profile-assets.json').write_text(json.dumps(base,indent=2)+'\n')
MANIFEST
[ "$?" -eq 0 ] || exit 2
for mode in baseline window; do
  export T77_MODE="$mode"
  export T77_ASSETS="$PWD/target/t77/baseline-assets.json"
  [ "$mode" = window ] && export T77_ASSETS="$PWD/target/t77/window-v8/profile-assets.json"
  export T77_OUT="$PWD/target/t77/window-v8/profile-$mode"
  /usr/bin/node acceptance/sidebar-profile/paired-profile.mjs 2>&1 | tee "target/t77/window-v8/profile-$mode.log"
  [ "${PIPESTATUS[0]}" -eq 0 ] || failed=1
done
exit "$failed"
