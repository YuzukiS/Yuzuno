#!/bin/bash
set -euo pipefail
umask 077
# conversation_read_bench was removed with the session store (T-140).
test -f core/examples/conversation_read_bench.rs || { echo "this needs a checkout of 586fd06 or earlier" >&2; exit 2; }
export CARGO_BUILD_JOBS=2
export CARGO_TARGET_DIR="$PWD/target/t81-build"
mkdir -p target/t81
test ! -e target/t81/baseline
fixture="${HOME}/yuzuno-next/.claude/worktrees/t77-sidebar-profile/target/t77/fixture.json"
cargo build --release --locked --offline -p yuzuno-workspace --example conversation_read_bench 2>&1 | tee target/t81/baseline-build.log
"$CARGO_TARGET_DIR/release/examples/conversation_read_bench" "$fixture" "$PWD/target/t81/baseline" 2>&1 | tee target/t81/baseline-run.log
python3 - <<'PY'
import hashlib,json,pathlib,subprocess
p=pathlib.Path('target/t81/baseline')
manifest={
 'head':subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip(),
 'base':'899b6565428e6d8541f0606c46ceb3e2dd42412d',
 'rustc':subprocess.check_output(['rustc','--version'],text=True).strip(),
 'binarySha256':hashlib.sha256(pathlib.Path('target/t81-build/release/examples/conversation_read_bench').read_bytes()).hexdigest(),
 'reportSha256':hashlib.sha256((p/'report.json').read_bytes()).hexdigest(),
}
(p/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
print(json.dumps(manifest))
PY
