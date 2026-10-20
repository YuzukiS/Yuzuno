#!/bin/bash
# One pinned baseline build for T-77; preserve it for matched comparisons.
# Run through Jobs and the shared heavy-slot, with a 2 GiB Node heap.
set -euo pipefail
umask 077
test "$NODE_OPTIONS" = --max-old-space-size=2048
test "$(git rev-parse HEAD)" = 8eac935a5a9a6536e33dbbf3ad43f8b6f013e19b
git diff --exit-code -- web
test ! -e target/t77/web-baseline
mkdir -p target/t77
python3 - <<'PY'
import hashlib,pathlib,shutil
root=pathlib.Path('.')
source=(pathlib.Path.home() / 'yuzuno-next/.claude/worktrees/t51-lazy-tools')
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
assert sha(root/'web/package-lock.json')==sha(source/'web/package-lock.json')
fixture=source/'target/t51/fixture.json'
assert sha(fixture)=='b17c868ec398ad5b23247d813aaef5e3dcf9b210bcfd2cd38e1f9f330e81c76d'
shutil.copyfile(fixture,root/'target/t77/fixture.json')
PY
if [ ! -d web/node_modules ]; then
  cp -a --reflink=auto "${HOME}/yuzuno-next/.claude/worktrees/t51-lazy-tools/web/node_modules" web/node_modules
fi
(
  cd web
  /usr/bin/node node_modules/typescript/bin/tsc -b
  /usr/bin/node node_modules/vite/bin/vite.js build --sourcemap --outDir ../target/t77/web-baseline
) 2>&1 | tee target/t77/baseline-build.log
python3 - <<'PY'
import hashlib,json,pathlib,subprocess
root=pathlib.Path('.').resolve()
web=root/'target/t77/web-baseline'
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
manifest={
 'task':'T-77',
 'sourceCommit':subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip(),
 'web':str(web),
 'sourcemaps':True,
 'fixture':str(root/'target/t77/fixture.json'),
 'fixtureSha256':sha(root/'target/t77/fixture.json'),
 'packageLockSha256':sha(root/'web/package-lock.json'),
 'node':subprocess.check_output(['/usr/bin/node','--version'],text=True).strip(),
 'chromium':subprocess.check_output(['/usr/sbin/chromium','--version'],text=True).strip(),
 'dailyContext':'Pinned core.5 source; isolated fixture on Linux headless Chromium, not daily Windows WebView2.',
 'sha256':{str(p.relative_to(web)):sha(p) for p in sorted(web.rglob('*')) if p.is_file()},
}
(root/'target/t77/baseline-assets.json').write_text(json.dumps(manifest,indent=2)+'\n')
print(json.dumps({'buildPassed':True,'sourceCommit':manifest['sourceCommit'],'fixtureSha256':manifest['fixtureSha256'],'assetFiles':len(manifest['sha256'])}))
PY

export T77_ASSETS=target/t77/baseline-assets.json
export T77_OUT=target/t77/baseline-profile
/bin/bash acceptance/sidebar-profile/sample.sh
