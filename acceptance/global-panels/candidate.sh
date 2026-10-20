#!/bin/bash
# Bounded first implementation check. Source hashes identify this working-tree
# candidate; reviewed/CI commits will be frozen after its behavior is checked.
set -euo pipefail
umask 077
test "$NODE_OPTIONS" = --max-old-space-size=2048
test "$LP_NUM_THREADS" = 2
test ! -e target/t68/web-candidate-v1
mkdir -p target/t68 "$TMPDIR"
python3 - <<'PY'
import hashlib,pathlib
p=pathlib.Path('target/t68/fixture.json')
assert hashlib.sha256(p.read_bytes()).hexdigest()=='b17c868ec398ad5b23247d813aaef5e3dcf9b210bcfd2cd38e1f9f330e81c76d'
PY
(
  cd web
  /usr/bin/node node_modules/typescript/bin/tsc -b
  /usr/bin/node node_modules/vite/bin/vite.js build --sourcemap --outDir ../target/t68/web-candidate-v1
) 2>&1 | tee target/t68/candidate-v1-build.log
python3 - <<'PY'
import hashlib,json,pathlib,subprocess
root=pathlib.Path('.').resolve(); web=root/'target/t68/web-candidate-v1'
sha=lambda b:hashlib.sha256(b).hexdigest()
base=json.loads((root/'target/t68/baseline-assets.json').read_text())
base.update({
 'web':str(web),
 'sourceCommit':subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip(),
 'sourceState':'working-tree candidate; identify implementation by trackedDiffSha256 and sourceFiles',
 'trackedDiffSha256':sha(subprocess.check_output(['git','diff','--','web'])),
 'sourceFiles':{p:sha((root/p).read_bytes()) for p in [
  'web/src/App.tsx','web/src/WorkspaceUpdates.tsx','web/src/OutgoingMessages.tsx','web/src/styles.css','web/tools/updates-browser.mjs']},
 'sha256':{str(p.relative_to(web)):sha(p.read_bytes()) for p in sorted(web.rglob('*')) if p.is_file()},
})
(root/'target/t68/candidate-v1-assets.json').write_text(json.dumps(base,indent=2)+'\n')
PY
export T68_ASSETS="$PWD/target/t68/candidate-v1-assets.json"
export T68_OUT="$PWD/target/t68/candidate-profile-v1"
export T68_MODE=baseline
/bin/bash acceptance/global-panels/sample.sh
export YUZUNO_UI_DIST="$PWD/target/t68/web-candidate-v1"
export YUZUNO_BROWSER_OUTPUT="$PWD/target/t68/candidate-v1-updates-browser"
export YUZUNO_BROWSER_BIN=/usr/sbin/chromium
(
  cd web
  /usr/bin/node --test tools/updates-ui.test.mjs tools/auto-read.test.mjs
) 2>&1 | tee target/t68/candidate-v1-focused-tests.log
taskset -c 8,9 /usr/bin/node web/tools/updates-browser.mjs 2>&1 | tee target/t68/candidate-v1-updates-browser.log
