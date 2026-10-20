#!/bin/bash
# Build and run the affected behavior checks in a Jobs cgroup under heavy-slot.
# Chromium uses the separately frozen T53 host with the paired 512-task limit.
set -euo pipefail
umask 077
test "$NODE_OPTIONS" = --max-old-space-size=2048
test "$(git rev-parse HEAD)" = 39b0b6fe7479acbd0dd3e61e47f469198922573a
mkdir -p target/t51 "$TMPDIR"
test ! -e target/t51/web-candidate
mode=${1:-all}
case "$mode" in
  all)
    git diff --binary HEAD -- web/src > target/t51/candidate-source.patch
    npm --prefix web run build 2>&1 | tee target/t51/candidate-build.log
    (
      cd web
      /usr/bin/node --test --test-reporter=tap \
        --test-name-pattern='deferred tools|latest tools|steering stays|tool counts|tool activity that arrives|catch-up|catch-up reply|turn dock|dock follows|drafts follow|settings suspend automatic reading|closing a file preview' \
        tools/ui.test.mjs
    ) 2>&1 | tee target/t51/candidate-ui.tap
    payload_log=target/t51/candidate-output.tap
    ;;
  --remaining)
    # A test-only fix can reuse a verified successful build and UI run.
    # The manifest is pinned as a Job input, alongside the retained source diff.
    python3 - <<'PY'
import hashlib, json, subprocess
from pathlib import Path
manifest = json.loads(Path('target/t51/candidate-built.json').read_text())
for name, digest in manifest['sha256'].items():
    assert hashlib.sha256(Path(name).read_bytes()).hexdigest() == digest, name
assert subprocess.check_output(['git', 'diff', '--binary', 'HEAD', '--', 'web/src']) == Path('target/t51/candidate-source.patch').read_bytes()
PY
    payload_log=target/t51/candidate-output-v2.tap
    ;;
  *) exit 2 ;;
esac
(
  cd web
  /usr/bin/node --test --test-reporter=tap tools/output-on-demand-ui.test.mjs
) 2>&1 | tee "$payload_log"
(
  cd web
  /usr/bin/node --test --test-reporter=tap tools/auto-read.test.mjs
) 2>&1 | tee target/t51/candidate-auto-read.tap
git diff --binary HEAD -- web/src > target/t51/candidate-source-after.patch
cmp target/t51/candidate-source.patch target/t51/candidate-source-after.patch
cp -a web/dist target/t51/web-candidate
python3 - <<'PY'
import hashlib, json, subprocess
from pathlib import Path
web = Path('target/t51/web-candidate').resolve()
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
git = lambda *args: subprocess.check_output(['git', *args], text=True).strip()
manifest = {
  'web': str(web),
  'sourceSha': git('rev-parse', 'HEAD'),
  'webTreeSha': git('rev-parse', 'HEAD:web'),
  'sourcePatchSha256': sha(Path('target/t51/candidate-source.patch')),
  'packageLockSha256': sha(Path('web/package-lock.json')),
  'profileSha256': sha(Path('acceptance/interaction-latency/profile.mjs')),
  'sha256': {str(p.relative_to(web)): sha(p) for p in sorted(web.rglob('*')) if p.is_file()},
}
Path('target/t51/candidate-assets.json').write_text(json.dumps(manifest, indent=2))
print(json.dumps({'passed': True, 'assets': str(web), 'sourcePatchSha256': manifest['sourcePatchSha256']}))
PY
