#!/bin/bash
set -euo pipefail
umask 077
# conversation_read_bench was removed with the session store (T-140).
test -f core/examples/conversation_read_bench.rs || { echo "this needs a checkout of 586fd06 or earlier" >&2; exit 2; }
export CARGO_BUILD_JOBS=2
export CARGO_TARGET_DIR="$PWD/target/t81-build"
run_name="${1:?new run name required}"
export T81_RUN_NAME="$run_name"
mkdir -p target/t81
test ! -e "target/t81/$run_name-unit.log"
cargo test --release --locked --offline -p yuzuno-workspace --lib window -- --test-threads=2 2>&1 | tee "target/t81/$run_name-unit.log"
cargo test --release --locked --offline -p yuzuno-workspace --test conversation_window --test record_rows -- --test-threads=2 2>&1 | tee "target/t81/$run_name-integration.log"
cargo build --release --locked --offline -p yuzuno-workspace --example conversation_read_bench 2>&1 | tee "target/t81/$run_name-build.log"
fixture="${HOME}/yuzuno-next/.claude/worktrees/t77-sidebar-profile/target/t77/fixture.json"
"$CARGO_TARGET_DIR/release/examples/conversation_read_bench" "$fixture" "$PWD/target/t81/$run_name" candidate 2>&1 | tee "target/t81/$run_name-run.log"
python3 - <<'PY'
import hashlib,json,pathlib,subprocess,os
p=pathlib.Path('target/t81')/os.environ['T81_RUN_NAME']
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
