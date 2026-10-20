#!/bin/bash
# Resume the structural checkpoint after correcting only its mock budget API.
# Reuse v1's successful production build; preserve v1's failed runner evidence.
set -euo pipefail
umask 077
test "$NODE_OPTIONS" = --max-old-space-size=2048
test "$LP_NUM_THREADS" = 2
test ! -e target/t77/window-v2
mkdir -p target/t77/window-v2
python3 - <<'PY'
import hashlib,json,pathlib
root=pathlib.Path('.').resolve()
job=json.loads((root/'target/t77/window-v1-job.json').read_text())
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
for entry in job['snapshot']['files']:
    p=pathlib.Path(entry['path'])
    if '/web/' in str(p): assert sha(p)==entry['sha256'],str(p)
web=root/'target/t77/web-window-v1'
(root/'target/t77/window-v2/assets.json').write_text(json.dumps({
 'buildJob':job['id'],'sourceHead':job['snapshot']['git']['head'],
 'files':{str(p.relative_to(web)):sha(p) for p in web.rglob('*') if p.is_file()}
},indent=2)+'\n')
PY
export TMPDIR="$(mktemp -d /tmp/t77-window.XXXXXX)"
trap 'rmdir "$TMPDIR" 2>/dev/null || true' EXIT
export YUZUNO_UI_DIST="$PWD/target/t77/web-window-v1"
export T77_OUT="$PWD/target/t77/window-v2/browser"
cp acceptance/sidebar-profile/window-check.mjs target/t77/window-v2/harness.mjs
failed=0
/bin/bash .github/scripts/web-tests.sh tools/ui.test.mjs tools/output-on-demand-ui.test.mjs tools/auto-read.test.mjs tools/composer-draft.test.mjs 2>&1 | tee target/t77/window-v2/tests.log || failed=1
/usr/bin/node acceptance/sidebar-profile/window-check.mjs 2>&1 | tee target/t77/window-v2/browser.log || failed=1
exit "$failed"
