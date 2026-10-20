#!/bin/bash
# Run inside a Jobs cgroup, under the shared heavy-slot wrapper. No nested scope.
set -euo pipefail
umask 077
expected=39b0b6fe7479acbd0dd3e61e47f469198922573a
test "$(git rev-parse HEAD)" = "$expected"
git diff --quiet HEAD -- web
test "$NODE_OPTIONS" = --max-old-space-size=2048
test "$T46_FIXTURE_SHA256" = b17c868ec398ad5b23247d813aaef5e3dcf9b210bcfd2cd38e1f9f330e81c76d
test "$T46_WEB" = "$PWD/target/t51/web-base"
mkdir -p "$TMPDIR" "$T46_OUT"
python3 - <<'PY'
import hashlib, os
from pathlib import Path
p = Path(os.environ['T46_OUT']) / 'fixture.json'
assert hashlib.sha256(p.read_bytes()).hexdigest() == os.environ['T46_FIXTURE_SHA256']
PY
npm --prefix web run build
test ! -e "$T46_WEB"
cp -a web/dist "$T46_WEB"
python3 - <<'PY'
import hashlib, json, os, subprocess
from pathlib import Path
web = Path(os.environ['T46_WEB'])
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
git = lambda *args: subprocess.check_output(['git', *args], text=True).strip()
manifest = {
  'web': str(web),
  'sourceSha': git('rev-parse', 'HEAD'),
  'webTreeSha': git('rev-parse', 'HEAD:web'),
  'packageLockSha256': sha(Path('web/package-lock.json')),
  'profileSha256': sha(Path('acceptance/interaction-latency/profile.mjs')),
  'sha256': {str(p.relative_to(web)): sha(p) for p in sorted(web.rglob('*')) if p.is_file()},
}
Path(os.environ['T46_ASSET_MANIFEST']).write_text(json.dumps(manifest, indent=2))
PY
node acceptance/interaction-latency/profile.mjs baseline --switch-only
