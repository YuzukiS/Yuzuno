#!/bin/bash
# Fixed reading-layout correction. Reuse the unchanged real API export from v6.
set -uo pipefail
umask 077
test "$NODE_OPTIONS" = --max-old-space-size=2048 || exit 2
test "$LP_NUM_THREADS" = 2 || exit 2
test ! -e target/t77/web-window-v7 || exit 2
mkdir -p target/t77/window-v7
git rev-parse HEAD > target/t77/window-v7/head.txt
git diff 8eac935a5a9a6536e33dbbf3ad43f8b6f013e19b -- core web acceptance/sidebar-profile > target/t77/window-v7/candidate.diff
export TMPDIR="$(mktemp -d /tmp/t77-window-v7.XXXXXX)"
trap 'rmdir "$TMPDIR" 2>/dev/null || true' EXIT
export T77_API_OUTPUT="$PWD/target/t77/window-v6/api-fixture.json"
python3 - <<'CHECK'
import hashlib, pathlib
p=pathlib.Path('target/t77/window-v6/api-fixture.json')
assert hashlib.sha256(p.read_bytes()).hexdigest() == '84e064831ca1ce00ed42bc755d2412d4acc0a6fd585b51c982aef714fc27d9bc'
CHECK
[ "$?" -eq 0 ] || exit 2
(
  cd web || exit
  /usr/bin/node node_modules/typescript/bin/tsc -b &&
  /usr/bin/node node_modules/vite/bin/vite.js build --sourcemap --outDir ../target/t77/web-window-v7
) 2>&1 | tee target/t77/window-v7/build.log
[ "${PIPESTATUS[0]}" -eq 0 ] || exit 1
export YUZUNO_UI_DIST="$PWD/target/t77/web-window-v7"
python3 - <<'ASSETS'
import hashlib,json,pathlib
web=pathlib.Path('target/t77/web-window-v7')
pathlib.Path('target/t77/window-v7/assets.json').write_text(json.dumps({str(p.relative_to(web)):hashlib.sha256(p.read_bytes()).hexdigest() for p in web.rglob('*') if p.is_file()},indent=2)+'\n')
ASSETS
failed=0
/bin/bash .github/scripts/web-tests.sh tools/ui.test.mjs 2>&1 | tee target/t77/window-v7/tests.log
[ "${PIPESTATUS[0]}" -eq 0 ] || failed=1
for scenario in compatibility api reading; do
  script=window-check.mjs
  [ "$scenario" = api ] && script=window-api-check.mjs
  [ "$scenario" = reading ] && script=window-reading-check.mjs
  export T77_OUT="$PWD/target/t77/window-v7/browser-$scenario"
  /usr/bin/node "acceptance/sidebar-profile/$script" 2>&1 | tee "target/t77/window-v7/browser-$scenario.log"
  [ "${PIPESTATUS[0]}" -eq 0 ] || failed=1
done
exit "$failed"
